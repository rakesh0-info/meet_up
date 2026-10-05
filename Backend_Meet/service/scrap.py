from typing import Dict, List, Any
import re
import requests as _requests
import bs4 as _bs4




def _get_page(url: str) -> _bs4.BeautifulSoup:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/120.0.0.0 Safari/537.36"
    }
    page = _requests.get(url, headers=headers)
    print(f"HTTP Status Code: {page.status_code}")
    
    soup = _bs4.BeautifulSoup(page.content, "html.parser")
    return soup





def get_full_website_details(url: str) -> Dict[str, Any]:
    """
    Extracts all core components from the website:
    Metadata, headings, paragraphs, links, and text content.
    """
    soup = _get_page(url)
    
    # 1. Page Title & Meta Description
    title = soup.title.string.strip() if soup.title else "No Title Found"
    
    meta_desc = ""
    meta_tag = soup.find("meta", attrs={"name": "description"})
    if meta_tag and meta_tag.get("content"):
        meta_desc = meta_tag["content"].strip()
        
    # 2. All Headings (H1, H2, H3) to understand structure
    h1_list = [h1.get_text(strip=True) for h1 in soup.find_all("h1")]
    h2_list = [h2.get_text(strip=True) for h2 in soup.find_all("h2")]
    h3_list = [h3.get_text(strip=True) for h3 in soup.find_all("h3")]
    # 3. All Paragraph Text (All content body)
    paragraphs = [p.get_text(strip=True) for p in soup.find_all("p") if p.get_text(strip=True)]
    
    # 4. All Unique Links
    links = list(set([a.get("href") for a in soup.find_all("a", href=True)]))
    
    # 5. Generate a Brief Introduction Summary
    intro_summary = f"This page is titled '{title}'."
    if meta_desc:
        intro_summary += f" Summary: {meta_desc}"
    elif paragraphs:
        # Use the first paragraph as a fallback intro
        intro_summary += f" Overview: {paragraphs[0][:200]}..."

    return {
        "url": url,
        "title": title,
        "meta_description": meta_desc,
        "brief_introduction": intro_summary,
        "headings_h1": h1_list,
        "headings_h2": h2_list[:5], # Limit to top 5 for brevity
        "total_paragraphs_found": len(paragraphs),
        "sample_paragraphs": paragraphs[:3], # First 3 paragraphs
        "total_links_found": len(links)
    }


