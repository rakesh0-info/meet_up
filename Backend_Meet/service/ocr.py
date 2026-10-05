import os
import requests
from dotenv import load_dotenv

load_dotenv()

def extract_text_via_api(file_bytes: bytes, filename: str = "image.png"):
    api_key = os.getenv("OCR_SPACE_API_KEY")
    url = os.getenv("OCR_URL", "https://api.ocr.space/parse/image")

    if not api_key:
        raise Exception("OCR_SPACE_API_KEY environment variable is missing!")

    payload = {
        'apikey': api_key,
        'language': 'eng',
        'isOverlayRequired': False
    }
    
    if not filename or '.' not in filename:
        filename = "image.png"

    files = {'file': (filename, file_bytes)}
    
    response = requests.post(url, data=payload, files=files)
    
    try:
        result = response.json()
    except Exception:
        raise Exception(f"Invalid JSON response from OCR API: {response.text}")
    
   
    if not result.get('IsErroredOnProcessing'):
        parsed_results = result.get('ParsedResults')
        if parsed_results:
            return parsed_results[0].get('ParsedText', '')
        return ''
    else:
        error_msg = result.get('ErrorMessage') or result.get('ErrorDetails') or str(result)
        raise Exception(f"OCR.space API Error: {error_msg}")