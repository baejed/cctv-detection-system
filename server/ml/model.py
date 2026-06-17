"""WarrantMLP - the architecture for the saved warrant_model.pt checkpoint.

Mirrors the architecture from the warrants/ training repo. The .pt checkpoint
stores `input_features`, `warrants`, `hidden_dims`, and `dropout` alongside
the state_dict so we can reconstruct the exact architecture at load time.
"""
from __future__ import annotations

import torch
from torch import nn


class WarrantMLP(nn.Module):
    def __init__(
        self,
        input_features: list[str],
        warrants: list[str],
        hidden_dims: tuple[int, ...],
        dropout: float,
    ) -> None:
        super().__init__()
        self.input_features = list(input_features)
        self.warrants = list(warrants)

        layers: list[nn.Module] = []
        in_dim = len(input_features)
        for h in hidden_dims:
            layers.append(nn.Linear(in_dim, h))
            layers.append(nn.ReLU())
            layers.append(nn.Dropout(dropout))
            in_dim = h
        layers.append(nn.Linear(in_dim, len(warrants)))

        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)
