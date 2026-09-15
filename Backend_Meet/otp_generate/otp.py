from datetime import datetime, timedelta, timezone
import random 
def generate_otp():
    return str(random.randint(100000, 999999))


def get_otp_expiry(minutes: int = 10) -> datetime:
    """Returns an awareness-aware UTC expiration time for the OTP."""
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)