import os
import asyncio
import requests
from dotenv import load_dotenv

load_dotenv()

MAILJET_API_KEY = os.getenv("MAILJET_API_KEY")
MAILJET_SECRET_KEY = os.getenv("MAILJET_SECRET_KEY")
MAILJET_SENDER_EMAIL = os.getenv("MAILJET_SENDER_EMAIL")

if not MAILJET_API_KEY or not MAILJET_SECRET_KEY:
    raise RuntimeError("MAILJET_API_KEY or MAILJET_SECRET_KEY is not configured.")


def _send_email_sync(receiver_mail: str, subject: str, body: str):
    """Synchronous helper to send email via Mailjet HTTP API safely in a background thread."""
    url = "https://api.mailjet.com/v3.1/send"
    
    payload = {
        "Messages": [
            {
                "From": {
                    "Email": MAILJET_SENDER_EMAIL,
                    "Name": "Phoenix Support"
                },
                "To": [
                    {
                        "Email": receiver_mail,
                        "Name": "User"
                    }
                ],
                "Subject": subject,
                "TextPart": body
            }
        ]
    }

    try:
        print(f"[MAILJET] Sending email | FROM: {MAILJET_SENDER_EMAIL} | TO: {receiver_mail}")
        
        # Mailjet uses HTTP Basic Authentication (API Key as username, Secret Key as password)
        response = requests.post(
            url,
            json=payload,
            auth=(MAILJET_API_KEY, MAILJET_SECRET_KEY)
        )
        
        if response.status_code != 200:
            raise Exception(f"Mailjet API Error [{response.status_code}]: {response.text}")
            
        print(f"[MAILJET] Successfully sent email to {receiver_mail}!")
        return response.json()

    except Exception as e:
        print(f"[MAILJET ERROR] Failed to send email to {receiver_mail}: {e}")
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