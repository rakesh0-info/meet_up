from enum import Enum
class CallStatus(str, Enum):
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    TERMINATED_NO_TOKENS = "TERMINATED_NO_TOKENS"
    NO_CALL="no_call_yet"