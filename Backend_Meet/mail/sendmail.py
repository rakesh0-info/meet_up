
import os
import asyncio

from dotenv import load_dotenv
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

load_dotenv()


# ============================================================
# ENVIRONMENT VARIABLES
# ============================================================

SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY")
SENDGRID_FROM_EMAIL = os.getenv("SENDGRID_FROM_EMAIL")
SENDGRID_FROM_NAME = os.getenv(
    "SENDGRID_FROM_NAME",
    "Phoenix Support"
)


# ============================================================
# VALIDATE CONFIGURATION
# ============================================================

if not SENDGRID_API_KEY:
    raise RuntimeError(
        "SENDGRID_API_KEY is not configured."
    )

if not SENDGRID_FROM_EMAIL:
    raise RuntimeError(
        "SENDGRID_FROM_EMAIL is not configured."
    )


# ============================================================
# SYNCHRONOUS SENDGRID HELPER
# ============================================================

def _send_email_sync(
    receiver_mail: str,
    subject: str,
    body: str
):
    """
    Synchronous SendGrid API call.

    This function is executed inside a worker thread
    by send_mail() / send_key().
    """

    try:
        print(
            f"[SENDGRID] Sending email | "
            f"FROM: {SENDGRID_FROM_EMAIL} | "
            f"TO: {receiver_mail}"
        )

        message = Mail(
            from_email=SENDGRID_FROM_EMAIL,
            to_emails=receiver_mail,
            subject=subject,
            plain_text_content=body
        )

        # Add sender display name
        message.from_email.name = SENDGRID_FROM_NAME

        sendgrid_client = SendGridAPIClient(
            SENDGRID_API_KEY
        )

        response = sendgrid_client.send(message)

        print(
            f"[SENDGRID] HTTP STATUS: "
            f"{response.status_code}"
        )

        print(
            f"[SENDGRID] RESPONSE BODY: "
            f"{response.body}"
        )

        print(
            f"[SENDGRID] RESPONSE HEADERS: "
            f"{response.headers}"
        )

        # SendGrid normally returns 202 when accepted
        if response.status_code not in (200, 201, 202):
            print(
                f"[SENDGRID ERROR] Email was not accepted. "
                f"Status: {response.status_code}"
            )

            return {
                "success": False,
                "status_code": response.status_code,
                "body": response.body.decode(
                    "utf-8",
                    errors="replace"
                )
            }

        print(
            f"[SENDGRID] Email accepted successfully "
            f"for {receiver_mail}"
        )

        return {
            "success": True,
            "status_code": response.status_code,
            "body": response.body.decode(
                "utf-8",
                errors="replace"
            )
        }

    except Exception as e:

        print(
            f"[SENDGRID ERROR] "
            f"Failed to send email to "
            f"{receiver_mail}: {e}"
        )

        return {
            "success": False,
            "status_code": 500,
            "body": str(e)
        }


# ============================================================
# SEND OTP EMAIL
# ============================================================

async def send_mail(
    receiver_mail: str,
    otp: str
):
    """
    Send OTP verification email.

    Usage:

        await send_mail(email, otp)
    """

    body = f"""
Hello,

Your Phoenix verification OTP is:

{otp}

This OTP will expire in 5 minutes.

If you did not request this OTP, please ignore this email.

Regards,
Phoenix Support
"""

    return await asyncio.to_thread(
        _send_email_sync,
        receiver_mail,
        "Your Phoenix Verification OTP",
        body
    )


# ============================================================
# SEND PASSWORD RESET KEY
# ============================================================

async def send_key(
    receiver_mail: str,
    key: str
):
    """
    Send password reset key.

    Usage:

        await send_key(email, key)
    """

    body = f"""
Hello,

Your Phoenix password reset key is:

{key}

Please use this key to reset your password.

If you did not request a password reset, please ignore this email.

Regards,
Phoenix Support
"""

    return await asyncio.to_thread(
        _send_email_sync,
        receiver_mail,
        "Your Phoenix Password Reset Key",
        body
    )
