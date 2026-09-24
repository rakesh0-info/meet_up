# import smtplib
# from email.mime.text import MIMEText
# from email.mime.multipart import MIMEMultipart
# import os
# import asyncio
# from dotenv import load_dotenv

# load_dotenv()

# SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com").strip()
# SMTP_PORT = int(os.getenv("SMTP_PORT", 465))            
# SENDER_EMAIL = os.getenv("SENDER_EMAIL")
# SENDER_PASSWORD = os.getenv("SMTP_PASSWORD")  

# def _send_mail_sync(receiver_mail: str, subject: str, body: str):
#     """Synchronous helper to block safely in a worker thread."""
#     msg = MIMEMultipart()
#     msg["From"] = SENDER_EMAIL
#     msg["To"] = receiver_mail
#     msg["Subject"] = subject
#     msg.attach(MIMEText(body, "plain"))

#     try:
#         print(f"DEBUG: Connecting to SMTP server for {receiver_mail}...")
#         with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT) as server:
#             server.login(SENDER_EMAIL, SENDER_PASSWORD)
#             server.send_message(msg)
#         print(f"DEBUG: Email successfully sent to {receiver_mail}!")
#     except Exception as e:
#         print("Error sending mail traceback:", e)
#         raise e

# async def send_mail(receiver_mail: str, otp: str):
#     body_content = f"This is your OTP: {otp}. It will expire in 5 minutes."
  
#     await asyncio.to_thread(_send_mail_sync, receiver_mail, "Your Verification OTP", body_content)


# async def send_key(receiver_mail: str, k: str):
#     body_content = f"This is your key : {k}. use it when u reset password ."
#     await asyncio.to_thread(_send_mail_sync, receiver_mail, "Your Verification key ", body_content)




import os
import resend
from dotenv import load_dotenv

load_dotenv()

# ============================================================
# RESEND CONFIGURATION
# ============================================================

RESEND_API_KEY = os.getenv("RESEND_API_KEY")

# Email that appears as the sender
RESEND_FROM_EMAIL = os.getenv(
    "RESEND_FROM_EMAIL",
    
)

if not RESEND_API_KEY:
    raise RuntimeError(
        "RESEND_API_KEY is not configured."
    )

resend.api_key = RESEND_API_KEY


# ============================================================
# COMMON EMAIL FUNCTION
# ============================================================

def _send_email(
    receiver_mail: str,
    subject: str,
    body: str
):
    try:
        print(
            f"[EMAIL] Sending email | "
            f"FROM: {RESEND_FROM_EMAIL} | "
            f"TO: {receiver_mail}"
        )

        params: resend.Emails.SendParams = {
            "from": RESEND_FROM_EMAIL,
            "to": [receiver_mail],
            "subject": subject,
            "text": body,
        }

        response = resend.Emails.send(params)

        print(
            f"[EMAIL] Successfully sent to {receiver_mail}"
        )

        print(f"[EMAIL] Resend response: {response}")

        return response

    except Exception as e:
        print(
            f"[EMAIL ERROR] Failed to send email "
            f"to {receiver_mail}: {e}"
        )

        raise


# ============================================================
# OTP EMAIL
# ============================================================

async def send_mail(
    receiver_mail: str,
    otp: str
):
    """
    Used for:

    - Registration OTP
    - Login OTP
    - Forgot password OTP
    """

    body = f"""
Hello,

Your OTP is:

{otp}

This OTP will expire in 5 minutes.

If you did not request this OTP, please ignore this email.

Regards,
Phoenix
"""

    return _send_email(
        receiver_mail=receiver_mail,
        subject="Your Verification OTP",
        body=body
    )


# ============================================================
# PASSWORD RESET KEY
# ============================================================

async def send_key(
    receiver_mail: str,
    key: str
):
    """
    Used for password reset secret key.
    """

    body = f"""
Hello,

Your password reset key is:

{key}

Please use this key to reset your password.

If you did not request a password reset, please ignore this email.

Regards,
Phoenix
"""

    return _send_email(
        receiver_mail=receiver_mail,
        subject="Your Password Reset Key",
        body=body
    )
