import easyocr
import easyocr
import numpy as np
import cv2
# Initialize the reader once globally.
READER = easyocr.Reader(['en'], gpu=False)

async def read_image(image_bytes: bytes):
    try:
        # 1. Convert raw uploaded bytes into a NumPy array that EasyOCR accepts
        nparr = np.frombuffer(image_bytes, np.uint8)
        img_np = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if img_np is None:
            return "Error reading image: Invalid image file data"

        # 2. Extract text using EasyOCR
        raw_text_list = READER.readtext(img_np, detail=0)
        
        # 3. Clean and format the output text
        cleaned_text = format_ocr_text(raw_text_list)
        return cleaned_text

    except Exception as e:
        return f"Error reading image: {e}"


def format_ocr_text(text_lines: list) -> str:
    filtered_lines = []
    for line in text_lines:
        line_clean = line.strip()
        if "JPEG" in line_clean or "compression" in line_clean:
            continue
        if line_clean:
            filtered_lines.append(line_clean)
            
    return " ".join(filtered_lines)