//! ML model predictions table and reducers for Ground Truth.
//!
//! This module defines:
//! - `ModelPrediction` table: stores per-pass failure probabilities with SHAP breakdown
//! - Reducers to insert/update predictions from the Python scoring pipeline
//!
//! Decision records in `decision_record` table reference `model_version` from these predictions.

use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};
use serde::Deserialize;

/// SHAP contribution for a single factor.
#[derive(SpacetimeType, Clone, Debug, Deserialize)]
pub struct ShapFactor {
    /// Human-readable factor name (e.g., "Kp Index", "Max Elevation")
    pub factor_name: String,
    /// SHAP contribution value (positive = increases failure probability)
    pub contribution: f32,
}

/// Model prediction for a satellite pass.
///
/// Stores the ML model's failure probability prediction along with
/// SHAP-based per-factor explanations and estimated dollar loss.
#[spacetimedb::table(accessor = model_prediction, public)]
pub struct ModelPrediction {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    
    /// Reference to the pass being predicted (pass.id)
    #[index(btree)]
    pub pass_id: u64,
    
    /// Version of the ML model that produced this prediction
    #[index(btree)]
    pub model_version: String,
    
    /// Predicted probability of pass failure [0.0, 1.0]
    pub failure_probability: f32,
    
    /// Estimated loss in cents (failure_probability × pass_value)
    pub estimated_loss_cents: i64,
    
    /// Top SHAP factors explaining the prediction (max 5)
    pub shap_factors: Vec<ShapFactor>,
    
    /// Full SHAP JSON for detailed analysis (optional)
    pub shap_json: Option<String>,
    
    /// Timestamp when prediction was generated
    pub created_at: Timestamp,
    
    /// Whether this is the latest prediction for the pass
    pub is_latest: bool,
}

/// Model version metadata.
#[spacetimedb::table(accessor = ml_model_version, public)]
pub struct MlModelVersion {
    #[primary_key]
    pub version: String,
    
    /// Model's AUC-ROC on test set
    pub auc_roc: f32,
    
    /// Model's Brier score (calibration)
    pub brier_score: f32,
    
    /// Expected Calibration Error
    pub ece: f32,
    
    /// Number of samples used for training
    pub training_samples: i32,
    
    /// Timestamp when model was registered
    pub created_at: Timestamp,
    
    /// Whether this is the currently active model
    pub is_active: bool,
}

/// Insert a new model prediction.
///
/// Called by the Python scoring pipeline after generating predictions.
/// Automatically marks previous predictions for the same pass as non-latest.
#[spacetimedb::reducer]
pub fn insert_model_prediction(
    ctx: &ReducerContext,
    pass_id: u64,
    model_version: String,
    failure_probability: f32,
    estimated_loss_cents: i64,
    shap_factors_json: String,
    shap_full_json: Option<String>,
) {
    // Parse SHAP factors from JSON
    // Expected format: [{"factor_name": "Kp Index", "contribution": 0.15}, ...]
    let shap_factors: Vec<ShapFactor> = match serde_json::from_str(&shap_factors_json) {
        Ok(factors) => factors,
        Err(e) => {
            log::warn!("Failed to parse SHAP factors: {}", e);
            vec![]
        }
    };
    
    // Mark previous predictions for this pass as non-latest
    for pred in ctx.db.model_prediction().iter() {
        if pred.pass_id == pass_id && pred.is_latest {
            ctx.db.model_prediction().id().update(ModelPrediction {
                is_latest: false,
                ..pred
            });
        }
    }
    
    // Insert new prediction
    ctx.db.model_prediction().insert(ModelPrediction {
        id: 0, // auto-inc
        pass_id,
        model_version: model_version.clone(),
        failure_probability,
        estimated_loss_cents,
        shap_factors,
        shap_json: shap_full_json,
        created_at: ctx.timestamp,
        is_latest: true,
    });
    
    log::info!(
        "Inserted prediction for pass {}: {:.1}% failure prob (model {})",
        pass_id,
        failure_probability * 100.0,
        model_version
    );
}

/// Batch insert multiple model predictions.
///
/// More efficient for scoring many passes at once.
#[spacetimedb::reducer]
pub fn batch_insert_predictions(
    ctx: &ReducerContext,
    predictions_json: String,
) {
    // Expected format: array of prediction objects
    #[derive(serde::Deserialize)]
    struct PredictionInput {
        pass_id: u64,
        model_version: String,
        failure_probability: f32,
        estimated_loss_cents: i64,
        shap_contributions: std::collections::HashMap<String, f32>,
    }
    
    let predictions: Vec<PredictionInput> = match serde_json::from_str(&predictions_json) {
        Ok(p) => p,
        Err(e) => {
            log::error!("Failed to parse predictions JSON: {}", e);
            return;
        }
    };
    
    let count = predictions.len();
    
    for pred_input in predictions {
        // Convert SHAP contributions to factors
        let mut shap_factors: Vec<ShapFactor> = pred_input.shap_contributions
            .into_iter()
            .map(|(name, contrib)| ShapFactor {
                factor_name: name,
                contribution: contrib,
            })
            .collect();
        
        // Sort by absolute contribution and take top 5
        shap_factors.sort_by(|a, b| {
            b.contribution.abs().partial_cmp(&a.contribution.abs()).unwrap()
        });
        shap_factors.truncate(5);
        
        // Mark previous predictions as non-latest
        for existing in ctx.db.model_prediction().iter() {
            if existing.pass_id == pred_input.pass_id && existing.is_latest {
                ctx.db.model_prediction().id().update(ModelPrediction {
                    is_latest: false,
                    ..existing
                });
            }
        }
        
        // Insert new prediction
        ctx.db.model_prediction().insert(ModelPrediction {
            id: 0,
            pass_id: pred_input.pass_id,
            model_version: pred_input.model_version,
            failure_probability: pred_input.failure_probability,
            estimated_loss_cents: pred_input.estimated_loss_cents,
            shap_factors,
            shap_json: None,
            created_at: ctx.timestamp,
            is_latest: true,
        });
    }
    
    log::info!("Batch inserted {} predictions", count);
}

/// Register a new model version with its metrics.
#[spacetimedb::reducer]
pub fn register_model_version(
    ctx: &ReducerContext,
    version: String,
    auc_roc: f32,
    brier_score: f32,
    ece: f32,
    training_samples: i32,
    make_active: bool,
) {
    // If making this version active, deactivate others
    if make_active {
        for existing in ctx.db.ml_model_version().iter() {
            if existing.is_active {
                ctx.db.ml_model_version().version().update(MlModelVersion {
                    is_active: false,
                    ..existing
                });
            }
        }
    }
    
    // Insert or update the version
    if let Some(existing) = ctx.db.ml_model_version().version().find(version.clone()) {
        ctx.db.ml_model_version().version().update(MlModelVersion {
            auc_roc,
            brier_score,
            ece,
            training_samples,
            is_active: make_active,
            ..existing
        });
    } else {
        ctx.db.ml_model_version().insert(MlModelVersion {
            version: version.clone(),
            auc_roc,
            brier_score,
            ece,
            training_samples,
            created_at: ctx.timestamp,
            is_active: make_active,
        });
    }
    
    log::info!(
        "Registered model version {}: AUC={:.4}, Brier={:.4}{}",
        version,
        auc_roc,
        brier_score,
        if make_active { " (active)" } else { "" }
    );
}

/// Get the currently active model version.
#[spacetimedb::reducer]
pub fn get_active_model_version(ctx: &ReducerContext) {
    for version in ctx.db.ml_model_version().iter() {
        if version.is_active {
            log::info!("Active model version: {}", version.version);
            return;
        }
    }
    log::warn!("No active model version found");
}
