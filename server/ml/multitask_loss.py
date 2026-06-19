"""Multi-task loss modules for the temporal warrant CNN.

Implements the loss formulation called out in
`docs/superpowers/plans/2026-06-19-multitask-warrant-cnn-prd.md`
(§Implementation Decisions / Multi-task loss):

  * **UncertaintyWeightedLoss.** Homoscedastic uncertainty weighting from
    Kendall, A., Gal, Y., & Cipolla, R. (2018). *Multi-Task Learning Using
    Uncertainty to Weigh Losses for Scene Geometry and Semantics*. CVPR 2018.
    Two learnable log-sigma parameters (one per task). Forward computes

        L = BCE_warrant / (2 * sigma_w**2)
          + CE_intervention / (2 * sigma_i**2)
          + log(sigma_w * sigma_i)

    matching the PRD's prototype-derived snippet verbatim. Parameterising
    in log-space (rather than directly on sigma) keeps the sigmas strictly
    positive without an explicit clamp and is the form recommended by the
    paper.

  * **EqualWeightedLoss.** The ablation baseline from
    §Implementation Decisions / Multi-task loss ("An equal-weighting
    ablation is also trained for the results chapter"). Sums the two
    losses with optional fixed weights; no learnable parameters.

Both classes share the same forward signature ``(bce_warrant,
ce_intervention) -> scalar`` so the T12 training CLI can swap between
them by config without restructuring its loop.

The caller is responsible for computing ``bce_warrant`` and
``ce_intervention`` themselves (via ``BCEWithLogitsLoss`` /
``CrossEntropyLoss`` against the two heads' logits). Keeping the
component losses out of this module lets training apply class-weighted
CE for the intervention head — per PRD §Training procedure / Class
imbalance — without this module having to know about class weights.
"""
from __future__ import annotations

import torch
from torch import nn


class UncertaintyWeightedLoss(nn.Module):
    """Kendall et al. 2018 homoscedastic uncertainty weighting.

    Args:
        init_log_sigma_warrant: Initial value for the warrant-head log-sigma
            parameter. Default 0.0 (sigma = 1, equal start). Optuna may
            tune this per PRD §Training procedure / Loss-weight initialisation.
        init_log_sigma_intervention: Initial value for the intervention-head
            log-sigma parameter. Default 0.0.
    """

    def __init__(
        self,
        init_log_sigma_warrant: float = 0.0,
        init_log_sigma_intervention: float = 0.0,
    ) -> None:
        super().__init__()
        self.log_sigma_w = nn.Parameter(torch.tensor([float(init_log_sigma_warrant)]))
        self.log_sigma_i = nn.Parameter(torch.tensor([float(init_log_sigma_intervention)]))

    def forward(
        self,
        bce_warrant: torch.Tensor,
        ce_intervention: torch.Tensor,
    ) -> torch.Tensor:
        """Combine the two task losses with learned uncertainty weights.

        Args:
            bce_warrant: Scalar tensor — mean ``BCEWithLogitsLoss`` over the
                six warrant logits.
            ce_intervention: Scalar tensor — mean ``CrossEntropyLoss`` over
                the three intervention logits.

        Returns:
            Scalar tensor: total weighted loss including the
            ``log(sigma_w * sigma_i)`` regulariser.
        """
        sigma_w = torch.exp(self.log_sigma_w)
        sigma_i = torch.exp(self.log_sigma_i)
        return (
            bce_warrant / (2.0 * sigma_w**2)
            + ce_intervention / (2.0 * sigma_i**2)
            + torch.log(sigma_w * sigma_i)
        ).squeeze()

    def sigmas(self) -> tuple[float, float]:
        """Return the current ``(sigma_w, sigma_i)`` as Python floats.

        Convenience for training logs / methods-chapter figures showing the
        learned task uncertainties over the course of training.
        """
        with torch.no_grad():
            return (
                float(torch.exp(self.log_sigma_w).item()),
                float(torch.exp(self.log_sigma_i).item()),
            )


class EqualWeightedLoss(nn.Module):
    """Equal-weight ablation baseline (no learnable parameters).

    Used for the §Testing Decisions / Results-chapter ablation comparing
    uncertainty-weighted vs. equal-weight loss. Weights default to 1.0
    each but can be set explicitly if a particular fixed mixing ratio is
    desired.
    """

    def __init__(
        self,
        weight_warrant: float = 1.0,
        weight_intervention: float = 1.0,
    ) -> None:
        super().__init__()
        if weight_warrant < 0 or weight_intervention < 0:
            raise ValueError("loss weights must be non-negative")
        self.weight_warrant = float(weight_warrant)
        self.weight_intervention = float(weight_intervention)

    def forward(
        self,
        bce_warrant: torch.Tensor,
        ce_intervention: torch.Tensor,
    ) -> torch.Tensor:
        return (
            self.weight_warrant * bce_warrant
            + self.weight_intervention * ce_intervention
        )


__all__ = [
    "UncertaintyWeightedLoss",
    "EqualWeightedLoss",
]
