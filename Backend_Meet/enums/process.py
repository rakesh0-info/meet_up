
from enum import Enum

class processing_status(str,Enum):
    PENDING="pending"
    COMPLETED="completed"
    FAILED="failed"