from enum import Enum

class status(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    PRE_ACTIVE = "pre_active"
    UPGRADE = "upgrade"
    EXPIRED = "expired"
    NOT_START="not_start_yet"