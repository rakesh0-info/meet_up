from enum import Enum

class re_status(str, Enum):
    ACCEPT="accept"
    REJECT="reject"
    NOT_SENT="not_send_yet"
    SENT="SENT"