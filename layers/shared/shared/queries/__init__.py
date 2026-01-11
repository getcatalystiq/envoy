"""Database query modules."""

from shared.queries.targets import TargetQueries
from shared.queries.content import ContentQueries
from shared.queries.campaigns import CampaignQueries
from shared.queries.outbox import OutboxQueries

__all__ = [
    "TargetQueries",
    "ContentQueries",
    "CampaignQueries",
    "OutboxQueries",
]
