"""
Training script for pass-failure prediction model.

Trains a LightGBM gradient-boosted model on SatNOGS observation outcomes
with SHAP-based explainability.

Usage:
    python -m ml.train [--samples N] [--output-dir PATH]
"""

import argparse
import json
import logging
import os
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Tuple, Optional

import numpy as np
import pandas as pd
import joblib
import lightgbm as lgb
from sklearn.model_selection import train_test_split, StratifiedKFold
from sklearn.metrics import (
    roc_auc_score,
    average_precision_score,
    brier_score_loss,
    log_loss,
    confusion_matrix,
    classification_report,
)
from sklearn.calibration import calibration_curve
import shap

from .data_loader import load_training_data
from .features import prepare_features, get_target, get_feature_display_name

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).parent / "models"
MODEL_DIR.mkdir(exist_ok=True)


def compute_calibration_metrics(y_true: np.ndarray, y_prob: np.ndarray) -> Dict[str, float]:
    """Compute calibration metrics for probabilistic predictions."""
    prob_true, prob_pred = calibration_curve(y_true, y_prob, n_bins=10, strategy="uniform")
    
    # Expected Calibration Error (ECE) - simplified calculation
    # Use mean absolute difference between predicted and actual probabilities
    ece = float(np.mean(np.abs(prob_true - prob_pred))) if len(prob_true) > 0 else 0.0
    
    return {
        "ece": ece,
        "brier_score": float(brier_score_loss(y_true, y_prob)),
        "log_loss": float(log_loss(y_true, y_prob)),
        "calibration_bins": {
            "predicted": prob_pred.tolist(),
            "actual": prob_true.tolist(),
        },
    }


def train_model(
    X: pd.DataFrame,
    y: pd.Series,
    feature_names: list,
    n_folds: int = 5,
    early_stopping_rounds: int = 50,
) -> Tuple[lgb.Booster, Dict[str, Any]]:
    """
    Train LightGBM model with cross-validation.
    
    Args:
        X: Feature matrix
        y: Target vector (1 = failure, 0 = success)
        feature_names: List of feature names
        n_folds: Number of CV folds
        early_stopping_rounds: Early stopping patience
        
    Returns:
        Tuple of (trained model, metrics dict)
    """
    logger.info(f"Training model on {len(X)} samples with {len(feature_names)} features")
    
    # Split for validation
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )
    
    # LightGBM parameters optimized for binary classification
    params = {
        "objective": "binary",
        "metric": "auc",
        "boosting_type": "gbdt",
        "num_leaves": 31,
        "learning_rate": 0.05,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "min_child_samples": 20,
        "reg_alpha": 0.1,
        "reg_lambda": 0.1,
        "verbose": -1,
        "seed": 42,
    }
    
    # Create datasets
    train_data = lgb.Dataset(
        X_train, 
        label=y_train,
        feature_name=feature_names,
        categorical_feature=[f for f in feature_names if X_train[f].dtype.name == "category"]
    )
    valid_data = lgb.Dataset(
        X_test, 
        label=y_test,
        feature_name=feature_names,
        reference=train_data
    )
    
    # Train with early stopping
    callbacks = [
        lgb.early_stopping(stopping_rounds=early_stopping_rounds),
        lgb.log_evaluation(period=100),
    ]
    
    model = lgb.train(
        params,
        train_data,
        num_boost_round=1000,
        valid_sets=[train_data, valid_data],
        valid_names=["train", "valid"],
        callbacks=callbacks,
    )
    
    # Evaluate on test set
    y_pred_proba = model.predict(X_test)
    y_pred = (y_pred_proba > 0.5).astype(int)
    
    # Compute metrics
    metrics = {
        "auc_roc": float(roc_auc_score(y_test, y_pred_proba)),
        "auc_pr": float(average_precision_score(y_test, y_pred_proba)),
        "accuracy": float((y_pred == y_test).mean()),
        "n_train": len(X_train),
        "n_test": len(X_test),
        "n_features": len(feature_names),
        "best_iteration": model.best_iteration,
    }
    
    # Calibration metrics
    calibration = compute_calibration_metrics(y_test.values, y_pred_proba)
    metrics.update({
        "brier_score": calibration["brier_score"],
        "log_loss": calibration["log_loss"],
        "ece": calibration["ece"],
    })
    
    # Confusion matrix
    cm = confusion_matrix(y_test, y_pred)
    metrics["confusion_matrix"] = cm.tolist()
    
    # Feature importance
    importance = model.feature_importance(importance_type="gain")
    metrics["feature_importance"] = {
        feature_names[i]: float(importance[i])
        for i in np.argsort(importance)[::-1]
    }
    
    logger.info(f"Model trained: AUC-ROC={metrics['auc_roc']:.4f}, Brier={metrics['brier_score']:.4f}")
    
    return model, metrics


def compute_shap_values(
    model: lgb.Booster,
    X: pd.DataFrame,
    feature_names: list,
    max_samples: int = 1000,
) -> Tuple[np.ndarray, float]:
    """
    Compute SHAP values for model explanations.
    
    Args:
        model: Trained LightGBM model
        X: Feature matrix
        feature_names: List of feature names
        max_samples: Max samples for SHAP computation
        
    Returns:
        Tuple of (SHAP values array, expected value)
    """
    logger.info(f"Computing SHAP values for {min(len(X), max_samples)} samples")
    
    # Sample if too large
    if len(X) > max_samples:
        X_sample = X.sample(n=max_samples, random_state=42)
    else:
        X_sample = X
    
    # Create SHAP explainer
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X_sample)
    
    return shap_values, explainer.expected_value


def save_model(
    model: lgb.Booster,
    metrics: Dict[str, Any],
    feature_names: list,
    shap_values: np.ndarray,
    expected_value: float,
    output_dir: Path,
    version: str,
) -> Dict[str, str]:
    """Save model, metrics, and SHAP baseline."""
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Save model
    model_path = output_dir / f"model_{version}.lgb"
    model.save_model(str(model_path))
    
    # Save model as joblib for easier loading
    joblib_path = output_dir / f"model_{version}.joblib"
    joblib.dump(model, joblib_path)
    
    # Save metrics
    metrics_path = output_dir / f"metrics_{version}.json"
    with open(metrics_path, "w") as f:
        json.dump(metrics, f, indent=2)
    
    # Save feature names and SHAP baseline
    config = {
        "version": version,
        "feature_names": feature_names,
        "shap_expected_value": float(expected_value),
        "created_at": datetime.utcnow().isoformat() + "Z",
        "metrics_summary": {
            "auc_roc": metrics["auc_roc"],
            "brier_score": metrics["brier_score"],
            "ece": metrics["ece"],
        },
    }
    config_path = output_dir / f"config_{version}.json"
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    
    # Save SHAP sample values for reference
    np.save(output_dir / f"shap_sample_{version}.npy", shap_values)
    
    logger.info(f"Model saved to {output_dir}")
    
    return {
        "model_path": str(model_path),
        "metrics_path": str(metrics_path),
        "config_path": str(config_path),
    }


def train_and_save(
    min_samples: int = 3000,
    output_dir: Optional[Path] = None,
    version: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Main training pipeline.
    
    Args:
        min_samples: Minimum training samples (augment with synthetic if needed)
        output_dir: Output directory for model artifacts
        version: Model version string
        
    Returns:
        Dict with training results and paths
    """
    if output_dir is None:
        output_dir = MODEL_DIR
    
    if version is None:
        version = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    
    # Load data
    df, data_stats = load_training_data(min_samples=min_samples, use_synthetic=True)
    
    if len(df) < 100:
        raise ValueError(f"Insufficient data: only {len(df)} samples available")
    
    # Prepare features
    X, feature_names = prepare_features(df)
    y = get_target(df)
    
    # Train model
    model, metrics = train_model(X, y, feature_names)
    
    # Compute SHAP values
    shap_values, expected_value = compute_shap_values(model, X, feature_names)
    
    # Save everything
    paths = save_model(
        model, metrics, feature_names, shap_values, expected_value,
        output_dir, version
    )
    
    # Add data stats to results
    results = {
        "version": version,
        "data_stats": data_stats,
        "metrics": metrics,
        "paths": paths,
    }
    
    # Print summary
    print("\n" + "=" * 60)
    print("TRAINING COMPLETE")
    print("=" * 60)
    print(f"\nModel Version: {version}")
    print(f"\nData:")
    print(f"  Real samples: {data_stats['real_samples']}")
    print(f"  Synthetic samples: {data_stats['synthetic_samples']}")
    print(f"  Total: {data_stats['total_samples']}")
    print(f"\nMetrics:")
    print(f"  AUC-ROC: {metrics['auc_roc']:.4f}")
    print(f"  AUC-PR: {metrics['auc_pr']:.4f}")
    print(f"  Brier Score: {metrics['brier_score']:.4f}")
    print(f"  ECE: {metrics['ece']:.4f}")
    print(f"  Accuracy: {metrics['accuracy']:.4f}")
    print(f"\nTop Features (by importance):")
    for i, (feat, imp) in enumerate(list(metrics["feature_importance"].items())[:5]):
        print(f"  {i+1}. {get_feature_display_name(feat)}: {imp:.2f}")
    print(f"\nModel saved to: {paths['model_path']}")
    print("=" * 60)
    
    return results


def main():
    parser = argparse.ArgumentParser(description="Train pass-failure prediction model")
    parser.add_argument(
        "--samples", type=int, default=3000,
        help="Minimum training samples (augment with synthetic if needed)"
    )
    parser.add_argument(
        "--output-dir", type=str, default=None,
        help="Output directory for model artifacts"
    )
    parser.add_argument(
        "--version", type=str, default=None,
        help="Model version string"
    )
    
    args = parser.parse_args()
    
    output_dir = Path(args.output_dir) if args.output_dir else None
    
    results = train_and_save(
        min_samples=args.samples,
        output_dir=output_dir,
        version=args.version,
    )
    
    return results


if __name__ == "__main__":
    main()
