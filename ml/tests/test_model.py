"""
Tests for pass-failure prediction model.
"""

import pytest
import numpy as np
import pandas as pd
from pathlib import Path
import tempfile
import json

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from ml.data_loader import generate_synthetic_observations, load_training_data
from ml.features import prepare_features, get_target, engineer_features
from ml.train import train_model, compute_calibration_metrics, train_and_save
from ml.score import PassFailureModel, PassPrediction


class TestDataLoader:
    """Tests for data loading and synthetic generation."""
    
    def test_generate_synthetic_observations(self):
        """Test synthetic observation generation."""
        df = generate_synthetic_observations(n_samples=100, seed=42)
        
        assert len(df) == 100
        assert "pass_id" in df.columns
        assert "max_elevation_deg" in df.columns
        assert "kp_at_time" in df.columns
        assert "outcome_label" in df.columns
        assert "status" in df.columns
        
        # Check value ranges
        assert df["max_elevation_deg"].min() >= 5
        assert df["max_elevation_deg"].max() <= 90
        assert df["kp_at_time"].min() >= 0
        assert df["kp_at_time"].max() <= 9
        
    def test_synthetic_class_balance(self):
        """Test that synthetic data has realistic class balance."""
        df = generate_synthetic_observations(n_samples=1000, seed=42)
        
        failure_rate = (df["outcome_label"] == 0).mean()
        
        # Should be roughly 15-35% failures
        assert 0.10 <= failure_rate <= 0.45, f"Failure rate {failure_rate} outside expected range"
    
    def test_load_training_data_with_augmentation(self):
        """Test loading training data with synthetic augmentation."""
        df, stats = load_training_data(min_samples=500, use_synthetic=True)
        
        assert len(df) >= 500
        assert "total_samples" in stats
        assert stats["total_samples"] >= 500


class TestFeatures:
    """Tests for feature engineering."""
    
    def test_prepare_features(self):
        """Test feature preparation."""
        df = generate_synthetic_observations(n_samples=50)
        X, feature_names = prepare_features(df)
        
        assert len(X) == 50
        assert len(feature_names) > 0
        assert "max_elevation_deg" in feature_names
        assert "kp_at_time" in feature_names
    
    def test_engineer_features(self):
        """Test derived feature engineering."""
        df = generate_synthetic_observations(n_samples=50)
        df = engineer_features(df)
        
        assert "is_high_latitude" in df.columns
        assert "pass_is_short" in df.columns
        assert "elevation_bin" in df.columns
    
    def test_get_target(self):
        """Test target extraction and inversion."""
        df = generate_synthetic_observations(n_samples=100)
        y = get_target(df)
        
        assert len(y) == 100
        assert set(y.unique()).issubset({0, 1})
        
        # Target should be inverted: failure=1, success=0
        # Original outcome_label: good=1, bad=0
        good_count = (df["outcome_label"] == 1).sum()
        failure_count = (y == 1).sum()
        
        assert good_count + failure_count == 100


class TestModel:
    """Tests for model training and prediction."""
    
    @pytest.fixture
    def sample_data(self):
        """Generate sample training data."""
        df = generate_synthetic_observations(n_samples=500, seed=42)
        X, features = prepare_features(df)
        y = get_target(df)
        return X, y, features
    
    def test_train_model(self, sample_data):
        """Test model training."""
        X, y, features = sample_data
        
        model, metrics = train_model(X, y, features, n_folds=3)
        
        assert model is not None
        assert "auc_roc" in metrics
        assert "brier_score" in metrics
        assert "feature_importance" in metrics
        
        # AUC should be better than random
        assert metrics["auc_roc"] > 0.55
    
    def test_calibration_metrics(self):
        """Test calibration metric computation."""
        np.random.seed(42)
        y_true = np.random.randint(0, 2, 100)
        y_prob = np.clip(y_true * 0.6 + np.random.random(100) * 0.4, 0, 1)
        
        metrics = compute_calibration_metrics(y_true, y_prob)
        
        assert "brier_score" in metrics
        assert "log_loss" in metrics
        assert "ece" in metrics
        assert 0 <= metrics["brier_score"] <= 1
    
    def test_train_and_save(self):
        """Test full training pipeline."""
        with tempfile.TemporaryDirectory() as tmpdir:
            results = train_and_save(
                min_samples=300,
                output_dir=Path(tmpdir),
                version="test_v1"
            )
            
            assert results["version"] == "test_v1"
            assert "metrics" in results
            assert "paths" in results
            
            # Check files were created
            assert Path(results["paths"]["model_path"]).exists()
            assert Path(results["paths"]["metrics_path"]).exists()
            assert Path(results["paths"]["config_path"]).exists()


class TestScoring:
    """Tests for model scoring."""
    
    @pytest.fixture
    def trained_model(self):
        """Train a model for scoring tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            train_and_save(
                min_samples=300,
                output_dir=Path(tmpdir),
                version="test_score"
            )
            yield PassFailureModel(model_dir=Path(tmpdir), version="test_score")
    
    def test_predict_proba(self, trained_model):
        """Test probability predictions."""
        df = generate_synthetic_observations(n_samples=10)
        
        probs = trained_model.predict_proba(df)
        
        assert len(probs) == 10
        assert all(0 <= p <= 1 for p in probs)
    
    def test_predict_with_shap(self, trained_model):
        """Test predictions with SHAP explanations."""
        df = generate_synthetic_observations(n_samples=5)
        
        predictions = trained_model.predict_with_shap(
            df,
            pass_ids=list(range(5)),
            revenue_cents=[100000] * 5
        )
        
        assert len(predictions) == 5
        
        for pred in predictions:
            assert isinstance(pred, PassPrediction)
            assert 0 <= pred.failure_probability <= 1
            assert pred.estimated_loss_cents >= 0
            assert len(pred.shap_contributions) > 0
    
    def test_score_passes(self, trained_model):
        """Test batch scoring."""
        df = generate_synthetic_observations(n_samples=10)
        df["pass_id"] = range(1000, 1010)
        df["revenue_cents"] = [50000] * 10
        
        results = trained_model.score_passes(df)
        
        assert len(results) == 10
        assert "failure_probability" in results.columns
        assert "estimated_loss_cents" in results.columns
        assert "shap_json" in results.columns
    
    def test_pass_prediction_serialization(self):
        """Test PassPrediction serialization."""
        pred = PassPrediction(
            pass_id=12345,
            failure_probability=0.25,
            estimated_loss_cents=75000,
            shap_contributions={"Kp Index": 0.15, "Max Elevation": -0.08},
            model_version="v1"
        )
        
        d = pred.to_dict()
        assert d["pass_id"] == 12345
        assert d["failure_probability"] == 0.25
        
        j = pred.to_spacetimedb_json()
        parsed = json.loads(j)
        assert parsed["pass_id"] == 12345


class TestEndToEnd:
    """End-to-end tests."""
    
    def test_full_pipeline(self):
        """Test full pipeline from data to predictions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            
            # Train
            results = train_and_save(
                min_samples=500,
                output_dir=tmpdir,
                version="e2e_test"
            )
            
            assert results["metrics"]["auc_roc"] > 0.55
            
            # Score
            model = PassFailureModel(model_dir=tmpdir, version="e2e_test")
            
            test_df = generate_synthetic_observations(n_samples=20, seed=99)
            predictions = model.predict_with_shap(test_df)
            
            assert len(predictions) == 20
            
            # All predictions should have valid probabilities
            for pred in predictions:
                assert 0 <= pred.failure_probability <= 1
                assert pred.model_version == "e2e_test"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
