import os
import asyncio
import resend
from dotenv import load_dotenv

load_dotenv()

RESEND_API_KEY = os.getenv("RESEND_API_KEY")
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", "onboarding@resend.dev")

if not RESEND_API_KEY:
    raise RuntimeError("RESEND_API_KEY is not configured.")

resend.api_key = RESEND_API_KEY


def _send_email_sync(receiver_mail: str, subject: str, body: str):
    """Synchronous helper for Resend API call to run safely in a worker thread."""
    try:
        print(f"[EMAIL] Sending email | FROM: {RESEND_FROM_EMAIL} | TO: {receiver_mail}")

        params = {
            "from": RESEND_FROM_EMAIL,
            "to": [receiver_mail],
            "subject": subject,
            "text": body,
        }

        response = resend.Emails.send(params)
        print(f"[EMAIL] Successfully sent to {receiver_mail}")
        print(f"[EMAIL] Resend response: {response}")
        return response

    except Exception as e:
        print(f"[EMAIL ERROR] Failed to send email to {receiver_mail}: {e}")
        raise


async def send_mail(receiver_mail: str, otp: str):
    body = f"""Hello,

Your OTP is:

{otp}

This OTP will expire in 5 minutes.

If you did not request this OTP, please ignore this email.

Regards,
Phoenix
"""
    # Run the synchronous resend call in a background thread safely
    return await asyncio.to_thread(_send_email_sync, receiver_mail, "Your Verification OTP", body)


async def send_key(receiver_mail: str, key: str):
    body = f"""Hello,

Your password reset key is:

{key}

Please use this key to reset your password.

If you did not request a password reset, please ignore this email.

Regards,
Phoenix
"""
    return await asyncio.to_thread(_send_email_sync, receiver_mail, "Your Password Reset Key", body)