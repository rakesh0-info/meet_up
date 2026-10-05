import pytesseract as pt
import os


# TESSERACT_PATH = r"C:\Program Files\Tesseract-OCR\tesseract.exe\tesseract.exe"

# if os.path.exists(TESSERACT_PATH):
#     pt.pytesseract.tesseract_cmd = TESSERACT_PATH

async def read_image(image_path, lang="eng"):
    try:
        raw_text = pt.image_to_string(image_path, lang=lang)
        
       
        cleaned_text = format_ocr_text(raw_text)
        return cleaned_text

    except Exception as e:
        return f"Error reading image: {e}"


def format_ocr_text(text: str) -> str:
    lines = text.splitlines()
    filtered_lines = []
    
    for line in lines:
        line_clean = line.strip()
        
        
        if "JPEG" in line_clean or "compression" in line_clean:
            continue
            
        if line_clean:
            filtered_lines.append(line_clean)
            
  
    return " ".join(filtered_lines)