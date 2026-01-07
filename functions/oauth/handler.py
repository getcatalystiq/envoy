"""OAuth Lambda handler entry point."""

from oauth.server import handler as oauth_handler


def lambda_handler(event, context):
    """Lambda entry point."""
    return oauth_handler(event, context)
