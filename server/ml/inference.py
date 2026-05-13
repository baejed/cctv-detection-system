"""Inference helpers for the warrant MLP.

Two public functions:
    load_warrant_model(model_path, scaler_path) -> WarrantArtifacts
    predict_warrants(artifacts, features) -> dict[str, float]

Both are pure functions. Call load_warrant_model once at app startup and cache
the result on app.state.
"""
from __future__ import annotations

import pickle
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch
from sklearn.preprocessing import StandardScaler

from server.ml.model import WarrantMLP


class WarrantArtifacts(NamedTuple):
    model: WarrantMLP
    scaler: StandardScaler
    input_features: list[str]
    warrants: list[str]


def load_warrant_model(model_path: Path, scaler_path: Path) -> WarrantArtifacts:
    """Load the warrant model and scaler from disk. Call once at app startup."""
    ckpt = torch.load(model_path, map_location="cpu", weights_only=False)
    model = WarrantMLP(
        input_features=ckpt["input_features"],
        warrants=ckpt["warrants"],
        hidden_dims=ckpt["hidden_dims"],
        dropout=ckpt["dropout"],
    )
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    with open(scaler_path, "rb") as f:
        scaler = pickle.load(f)

    return WarrantArtifacts(
        model=model,
        scaler=scaler,
        input_features=ckpt["input_features"],
        warrants=ckpt["warrants"],
    )


def predict_warrants(
    artifacts: WarrantArtifacts,
    features: dict[str, float],
) -> dict[str, float]:
    """Run inference on one feature dict, return {warrant_name: probability}."""
    ordered = np.array(
        [[features[name] for name in artifacts.input_features]],
        dtype=np.float32,
    )
    scaled = artifacts.scaler.transform(ordered).astype(np.float32)
    with torch.no_grad():
        logits = artifacts.model(torch.from_numpy(scaled))
        probs = torch.sigmoid(logits).squeeze(0).tolist()
    return dict(zip(artifacts.warrants, probs))
