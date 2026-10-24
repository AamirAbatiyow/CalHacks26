"""
Scoring module for pass-failure predictions.

Loads trained model and produces per-pass failure probabilities
with SHAP-based per-factor contributions.

The output is formatted for SpacetimeDB's model_prediction table.
"""

import json
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass

import numpy as np
import pandas as pd
import joblib
import shap

from .features import prepare_features, get_feature_display_name, engineer_features
from . import datasets as ds
from .gate import gate_decision

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).parent / "models"


@dataclass
class PassPrediction:
    """Prediction result for a single pass."""
    pass_id: int
    failure_probability: float
    estimated_loss_cents: int
    shap_contributions: Dict[str, float]
    model_version: str
    gate_confidence_percent: Optional[int] = None
    gate_route: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        d = {
            "pass_id": self.pass_id,
            "failure_probability": round(self.failure_probability, 4),
            "estimated_loss_cents": self.estimated_loss_cents,
            "shap_contributions": self.shap_contributions,
            "model_version": self.model_version,
        }
        if self.gate_confidence_percent is not None:
            # Feed to confidence_gate::process_claim_decision as confidence_percent.
            d["gate_confidence_percent"] = self.gate_confidence_percent
            d["gate_route"] = self.gate_route
        return d
    
    def to_spacetimedb_json(self) -> str:
        """Format for SpacetimeDB reducer call."""
        return json.dumps(self.to_dict())


class PassFailureModel:
    """Wrapper for pass-failure prediction model."""
    
    def __init__(self, model_dir: Optional[Path] = None, version: Optional[str] = None):
        """
        Load model from disk.
        
        Args:
            model_dir: Directory containing model files
            version: Specific version to load (default: latest)
        """
        self.model_dir = model_dir or MODEL_DIR
        self.version = version
        self.model = None
        self.config = None
        self.explainer = None
        self.calibrator = None
        
        self._load_model()
    
    def _load_model(self):
        """Load model and config from disk."""
        if self.version is None:
            # Find latest version
            config_files = list(self.model_dir.glob("config_*.json"))
            if not config_files:
                raise FileNotFoundError(f"No model configs found in {self.model_dir}")
            
            # Sort by name (timestamp) to get latest
            config_files.sort(reverse=True)
            config_path = config_files[0]
            self.version = config_path.stem.replace("config_", "")
        else:
            config_path = self.model_dir / f"config_{self.version}.json"
        
        # Load config
        with open(config_path) as f:
            self.config = json.load(f)
        
        # Load model
        model_path = self.model_dir / f"model_{self.version}.joblib"
        if not model_path.exists():
            model_path = self.model_dir / f"model_{self.version}.lgb"
        
        self.model = joblib.load(model_path)
        calibrator_path = self.model_dir / f"calibrator_{self.version}.joblib"
        if calibrator_path.exists():
            self.calibrator = joblib.load(calibrator_path)
        
        # Create SHAP explainer
        self.explainer = shap.TreeExplainer(self.model)
        
        logger.info(f"Loaded model version {self.version}")
    
    @property
    def feature_names(self) -> List[str]:
        return self.config["feature_names"]
    
    @property
    def shap_expected_value(self) -> float:
        return self.config["shap_expected_value"]
    
    @property
    def is_heldout_pipeline(self) -> bool:
        return self.config.get("pipeline") == "heldout"

    def _prepare(self, X: pd.DataFrame) -> Tuple[pd.DataFrame, List[str]]:
        if not self.is_heldout_pipeline:
            return prepare_features(X, self.feature_names)
        # Station-state inputs (recent_*_lag1h) come from the caller's record of the
        # station's earlier passes (see datasets.station_recent_state); missing -> NaN.
        df = ds.add_physical_features(X.reset_index(drop=True))
        cfg = self.config
        out = pd.DataFrame(index=df.index)
        for c in cfg["numeric_features"]:
            out[c] = pd.to_numeric(df[c], errors="coerce") if c in df.columns else np.nan
        for c in cfg["categorical_features"]:
            values = df[c].fillna("NA").astype(str) if c in df.columns else ["NA"] * len(df)
            out[c] = pd.Categorical(values, categories=cfg["categories"][c])
        return out[self.feature_names], self.feature_names

    def _calibrate(self, raw: np.ndarray) -> np.ndarray:
        return self.calibrator.predict(raw) if self.calibrator is not None else raw

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        """Predict failure probabilities."""
        X_prepared, _ = self._prepare(X)
        return self._calibrate(self.model.predict(X_prepared))
    
    def predict_with_shap(
        self,
        X: pd.DataFrame,
        pass_ids: Optional[List[int]] = None,
        revenue_cents: Optional[List[int]] = None,
    ) -> List[PassPrediction]:
        """
        Predict failure probabilities with SHAP explanations.
        
        Args:
            X: Feature DataFrame for passes
            pass_ids: List of pass IDs (default: use index)
            revenue_cents: List of pass revenue values for loss calculation
            
        Returns:
            List of PassPrediction objects
        """
        # Prepare features
        X_prepared, features = self._prepare(X)
        
        # Get predictions
        probs = self._calibrate(self.model.predict(X_prepared))
        
        # Get SHAP values
        shap_values = self.explainer.shap_values(X_prepared)
        
        # Build results
        if pass_ids is None:
            pass_ids = X.index.tolist() if hasattr(X, 'index') else list(range(len(X)))
        
        if revenue_cents is None:
            # Default revenue estimate: $3/min for 10-min pass = $30 = 3000 cents
            revenue_cents = [300000] * len(X)  # $3000 default
        
        results = []
        for i in range(len(X_prepared)):
            # SHAP contributions as dict
            contributions = {}
            for j, feat in enumerate(features):
                shap_val = float(shap_values[i, j])
                if abs(shap_val) > 0.001:  # Only include meaningful contributions
                    display_name = get_feature_display_name(feat)
                    contributions[display_name] = round(shap_val, 4)
            
            # Sort by absolute contribution
            contributions = dict(
                sorted(contributions.items(), key=lambda x: abs(x[1]), reverse=True)
            )
            
            # Calculate estimated loss
            prob = float(probs[i])
            revenue = revenue_cents[i] if i < len(revenue_cents) else 300000
            loss_cents = int(prob * revenue)
            
            gate = gate_decision(prob, self.config.get("gate")) if self.is_heldout_pipeline else None
            results.append(PassPrediction(
                pass_id=pass_ids[i],
                failure_probability=prob,
                estimated_loss_cents=loss_cents,
                shap_contributions=contributions,
                model_version=self.version,
                gate_confidence_percent=gate["confidence_percent"] if gate else None,
                gate_route=gate["route"] if gate else None,
            ))
        
        return results
    
    def score_passes(self, passes_df: pd.DataFrame) -> pd.DataFrame:
        """
        Score a DataFrame of passes and return results DataFrame.
        
        Args:
            passes_df: DataFrame with pass features
            
        Returns:
            DataFrame with predictions and SHAP contributions
        """
        pass_ids = passes_df.get("pass_id", passes_df.index).tolist()
        revenue = list(passes_df["revenue_cents"]) if "revenue_cents" in passes_df else [300000] * len(passes_df)
        
        predictions = self.predict_with_shap(passes_df, pass_ids, revenue)
        
        results = []
        for pred in predictions:
            row = {
                "pass_id": pred.pass_id,
                "failure_probability": pred.failure_probability,
                "estimated_loss_cents": pred.estimated_loss_cents,
                "model_version": pred.model_version,
                "gate_confidence_percent": pred.gate_confidence_percent,
                "gate_route": pred.gate_route,
            }
            # Add top 3 SHAP factors
            for i, (factor, contrib) in enumerate(list(pred.shap_contributions.items())[:3]):
                row[f"shap_factor_{i+1}"] = factor
                row[f"shap_contrib_{i+1}"] = contrib
            
            row["shap_json"] = json.dumps(pred.shap_contributions)
            results.append(row)
        
        return pd.DataFrame(results)


def score_from_json(passes_json: str, model_version: Optional[str] = None) -> str:
    """
    Score passes from JSON input and return JSON output.
    
    This function is designed to be called from external scripts
    (e.g., SpacetimeDB reducer integration).
    
    Args:
        passes_json: JSON array of pass objects
        model_version: Specific model version to use
        
    Returns:
        JSON array of prediction objects
    """
    passes = json.loads(passes_json)
    df = pd.DataFrame(passes)
    
    model = PassFailureModel(version=model_version)
    
    pass_ids = df.get("pass_id", df.index).tolist()
    revenue = list(df["revenue_cents"]) if "revenue_cents" in df else [300000] * len(df)
    
    predictions = model.predict_with_shap(df, pass_ids, revenue)
    
    return json.dumps([p.to_dict() for p in predictions], indent=2)


def main():
    """Demo scoring with sample data."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Score passes for failure probability")
    parser.add_argument("--input", type=str, help="Input JSON file with passes")
    parser.add_argument("--output", type=str, help="Output JSON file for predictions")
    parser.add_argument("--version", type=str, help="Model version to use")
    parser.add_argument("--demo", action="store_true", help="Run demo with synthetic data")
    
    args = parser.parse_args()
    
    if args.demo:
        # Demo with synthetic passes
        from .data_loader import generate_synthetic_observations
        
        df = generate_synthetic_observations(n_samples=10)
        
        model = PassFailureModel(version=args.version)
        results = model.score_passes(df)
        
        print("\nSample Predictions:")
        print("=" * 80)
        for _, row in results.iterrows():
            print(f"\nPass {row['pass_id']}:")
            print(f"  Failure Probability: {row['failure_probability']:.1%}")
            print(f"  Estimated Loss: ${row['estimated_loss_cents']/100:.2f}")
            print(f"  Top Factors:")
            for i in range(1, 4):
                factor = row.get(f'shap_factor_{i}')
                contrib = row.get(f'shap_contrib_{i}')
                if factor and contrib:
                    direction = "↑" if contrib > 0 else "↓"
                    print(f"    {direction} {factor}: {contrib:+.3f}")
    
    elif args.input:
        with open(args.input) as f:
            passes_json = f.read()
        
        output_json = score_from_json(passes_json, args.version)
        
        if args.output:
            with open(args.output, "w") as f:
                f.write(output_json)
            print(f"Predictions written to {args.output}")
        else:
            print(output_json)
    
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
