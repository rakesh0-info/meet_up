import os
import requests
from dotenv import load_dotenv

load_dotenv()

MAILJET_API_KEY = os.getenv("MAILJET_API_KEY")
MAILJET_SECRET_KEY = os.getenv("MAILJET_SECRET_KEY")
MAILJET_SENDER_EMAIL = os.getenv("MAILJET_SENDER_EMAIL")

if not MAILJET_API_KEY or not MAILJET_SECRET_KEY:
    raise RuntimeError("MAILJET_API_KEY or MAILJET_SECRET_KEY is not configured.")


def send_mail(receiver_mail: str, otp: str):
    """Synchronous function safe for FastAPI BackgroundTasks."""
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
                "Subject": "Your Verification OTP",
                "TextPart": f"Hello,\n\nYour OTP is:\n\n{otp}\n\nThis OTP will expire in 5 minutes.\n\nRegards,\nPhoenix"
            }
        ]
    }

    try:
        print(f"[MAILJET] Sending email | FROM: {MAILJET_SENDER_EMAIL} | TO: {receiver_mail}")
        response = requests.post(
            url,
            json=payload,
            auth=(MAILJET_API_KEY, MAILJET_SECRET_KEY),
            timeout=10
        )
        
        if response.status_code != 200:
            print(f"[MAILJET ERROR] API Error [{response.status_code}]: {response.text}")
        else:
            print(f"[MAILJET] Successfully sent email to {receiver_mail}!")
            
        return response.json()

    except Exception as e:
        print(f"[MAILJET ERROR] Failed to send email to {receiver_mail}: {e}")


def send_key(receiver_mail: str, key: str):
    """Synchronous function safe for FastAPI BackgroundTasks."""
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
                "Subject": "Your Password Reset Key",
                "TextPart": f"Hello,\n\nYour password reset key is:\n\n{key}\n\nPlease use this key to reset your password.\n\nRegards,\nPhoenix"
            }
        ]
    }

    try:
        print(f"[MAILJET] Sending password key | TO: {receiver_mail}")
        response = requests.post(
            url,
            json=payload,
            auth=(MAILJET_API_KEY, MAILJET_SECRET_KEY),
            timeout=10
        )
        if response.status_code != 200:
            print(f"[MAILJET ERROR] API Error [{response.status_code}]: {response.text}")
        else:
            print(f"[MAILJET] Successfully sent password key to {receiver_mail}!")
    except Exception as e:
        print(f"[MAILJET ERROR] Failed to send key: {e}")