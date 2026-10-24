"""
ML module for Ground Truth pass-failure prediction.

This module provides:
- Training pipeline for gradient-boosted models (LightGBM)
- Feature engineering from SatNOGS observations and space weather
- SHAP-based explainability for per-pass failure predictions
- Integration with SpacetimeDB via model predictions table
"""

__version__ = "1.0.0"
