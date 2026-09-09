import os
import csv
import sys
import time
import random
from datetime import datetime
from urllib.parse import urlparse
from config import config
from exa_search import ExaSearch
from apify_scraper import ApifyScraper
from cover_letter_generator import CoverLetterGenerator
from email_sender import EmailSender

QUEUE_FILE = "outreach_queue.csv"
LOG_FILE = "outreach_log.csv"
LETTERS_DIR = "generated_letters"
CV_PATH = "Annin_Kakra_Afriyie_CV.pdf"

# Initialize services
exa = None
apify = None
generator = CoverLetterGenerator()
sender = None

def get_exa():
    global exa
    if not exa:
        exa = ExaSearch()
    return exa

def get_apify():
    global apify
    if not apify:
        apify = ApifyScraper()
    return apify

def get_sender():
    global sender
    if not sender:
        sender = EmailSender()
    return sender

def load_queue():
    queue = []
    if not os.path.exists(QUEUE_FILE):
        return queue
    with open(QUEUE_FILE, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            queue.append(row)
    return queue

def save_queue(queue):
    fields = [
        "company_name", "website", "email", "company_type", 
        "recipient_name", "company_address", "status", 
        "date_added", "date_sent"
    ]
    with open(QUEUE_FILE, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in queue:
            writer.writerow(row)

def add_to_queue(company_name, website, email="", company_type="general_startup", recipient="The Recruiting and Technology Team", address="Accra, Ghana"):
    queue = load_queue()
    # Deduplicate by company name or website
    for row in queue:
        if row["company_name"].lower() == company_name.lower():
            return False
        if website and row["website"].lower() == website.lower():
            return False
            
    new_row = {
        "company_name": company_name,
        "website": website,
        "email": email,
        "company_type": company_type,
        "recipient_name": recipient,
        "company_address": address,
        "status": "Pending",
        "date_added": datetime.now().strftime("%Y-%m-%d"),
        "date_sent": ""
    }
    queue.append(new_row)
    save_queue(queue)
    print(f"[Queue] Added company: {company_name}")
    return True

def import_unhyped_employers():
    """
    Parses unhyped_ghana_tech_employers.md and imports the companies into the queue.
    """
    print("[Import] Importing companies from unhyped_ghana_tech_employers.md...")
    md_path = "unhyped_ghana_tech_employers.md"
    if not os.path.exists(md_path):
        print(f"[Import] Error: {md_path} not found.")
        return
        
    # Standard mapping based on sections in the markdown file
    current_type = "general_startup"
    with open(md_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("## "):
                # Identify section type
                sec = line.lower()
                if "consultancies" in sec:
                    current_type = "consultancy"
                elif "software houses" in sec:
                    current_type = "fintech" # softtribe/itconsortium are transactional/database systems
                elif "isps" in sec or "telecommunications" in sec:
                    current_type = "isp"
                elif "bank" in sec:
                    current_type = "bank"
                elif "power" in sec or "utilities" in sec:
                    current_type = "consultancy" # utility cloud platforms behave like consultancy/infrastructure
                    
            if line.startswith("### "):
                # Found a company: e.g. "### 1. Enterprise Computing Limited (ECL)"
                name = line.replace("###", "").strip()
                # strip number prefixes like "1. " or "2. "
                parts = name.split(". ", 1)
                if len(parts) > 1:
                    name = parts[1]
                    
                # Read description lines below to find details
                # For simplicity, we add it with default values first.
                # The user can edit or we can scrape to enrich.
                add_to_queue(
                    company_name=name,
                    website="", # Scraper/Exa can resolve website URL
                    email="",
                    company_type=current_type,
                    recipient="The Recruiting and Technology Team",
                    address="Accra, Ghana"
                )

def run_exa_search(query_str, limit=15):
    """
    Searches for new companies using Exa and adds them to queue.
    """
    print(f"[Pipeline] Executing Exa search for query: '{query_str}'...")
    search_service = get_exa()
    raw_results = search_service.search_companies(query_str, num_results=limit)
    cleaned = search_service.get_company_domains(raw_results)
    
    added_count = 0
    for c in cleaned:
        # Determine company type based on name or metadata text
        txt = c["text"].lower()
        name = c["name"].split(" - ")[0].split(" | ")[0].strip()
        
        ctype = "general_startup"
        if "consulting" in txt or "managed service" in txt:
            ctype = "consultancy"
        elif "fintech" in txt or "payment" in txt or "transaction" in txt:
            ctype = "fintech"
        elif "telecom" in txt or "isp" in txt or "network" in txt:
            ctype = "isp"
        elif "bank" in txt or "fidelity" in txt or "ecobank" in txt:
            ctype = "bank"
            
        success = add_to_queue(
            company_name=name,
            website=c["domain"],
            email="",
            company_type=ctype,
            recipient="The Recruiting and Technology Team",
            address="Accra, Ghana"
        )
        if success:
            added_count += 1
            
    print(f"[Pipeline] Exa search complete. Added {added_count} new companies to queue.")

def run_apify_scrape():
    """
    Finds all companies in queue with empty website or empty email, 
    resolves websites (if empty) or crawls them via Apify.
    """
    queue = load_queue()
    pending = [r for r in queue if r["status"] == "Pending" and not r["email"]]
    
    if not pending:
        print("[Pipeline] No pending companies in queue that require email scraping.")
        return
        
    print(f"[Pipeline] Found {len(pending)} companies needing email scraping.")
    
    # We scrape in batches to avoid overwhelming the scraper
    # Let's take up to 5 URLs to crawl at a time
    batch = pending[:5]
    urls_to_crawl = []
    
    for r in batch:
        web = r["website"]
        # If website URL is missing, we use Exa to find it!
        if not web:
            print(f"[Pipeline] Website URL missing for '{r['company_name']}'. Searching Exa...")
            search_service = get_exa()
            results = search_service.search_companies(f"{r['company_name']} Ghana official website homepage", num_results=1)
            if results:
                parsed = urlparse(results[0]["url"])
                web = f"{parsed.scheme}://{parsed.netloc}"
                r["website"] = web
                print(f"[Pipeline] Found website: {web}")
            else:
                print(f"[Pipeline] Could not find website for '{r['company_name']}'. Skipping scrape.")
                continue
        urls_to_crawl.append((r["company_name"], web))
        
    if not urls_to_crawl:
        save_queue(queue)
        print("[Pipeline] No valid URLs found to crawl in this batch.")
        return
        
    # Execute Apify scrape
    just_urls = [web for name, web in urls_to_crawl]
    scraper_service = get_apify()
    scraped_data = scraper_service.run_contact_scraper(just_urls, max_pages=8, depth=1)
    
    # Map scraped data back to queue
    updated_count = 0
    processed_domains = set()
    for name, web in urls_to_crawl:
        parsed = urlparse(web)
        dom = parsed.netloc.lower()
        if dom.startswith("www."):
            dom = dom[4:]
        processed_domains.add(dom)

    successful_domains = set()
    for item in scraped_data:
        scraped_url = item.get("originalStartUrl") or item.get("url", "")
        domain_field = item.get("domain", "")
        
        scraped_domain = domain_field.lower() if domain_field else ""
        if not scraped_domain and scraped_url:
            scraped_domain = urlparse(scraped_url).netloc.lower()
            
        if scraped_domain.startswith("www."):
            scraped_domain = scraped_domain[4:]
            
        if not scraped_domain:
            continue
        
        # Find emails
        emails_list = item.get("emails", [])
        # filter out invalid emails (like PNG, JPG, or placeholder strings)
        valid_emails = [e for e in emails_list if "@" in e and "." in e.split("@")[1]]
        
        if not valid_emails:
            continue
            
        # Get primary email (prefer recruiter, contact, HR, jobs; else first)
        primary_email = ""
        for email in valid_emails:
            el = email.lower()
            if any(k in el for k in ["hr", "career", "job", "recruitment", "hire", "people", "contact"]):
                primary_email = email
                break
        if not primary_email:
            primary_email = valid_emails[0]
            
        # Update queue row
        for r in queue:
            if r["website"]:
                parsed_row = urlparse(r["website"])
                row_domain = parsed_row.netloc.lower()
                if row_domain.startswith("www."):
                    row_domain = row_domain[4:]
                if row_domain == scraped_domain or row_domain.endswith("." + scraped_domain) or scraped_domain.endswith("." + row_domain):
                    r["email"] = primary_email
                    print(f"[Pipeline] Found email '{primary_email}' for '{r['company_name']}'")
                    updated_count += 1
                    successful_domains.add(row_domain)
                    break

    # Mark domains that were crawled but failed to find emails
    for dom in processed_domains:
        if dom not in successful_domains:
            for r in queue:
                if r["website"]:
                    parsed_row = urlparse(r["website"])
                    row_domain = parsed_row.netloc.lower()
                    if row_domain.startswith("www."):
                        row_domain = row_domain[4:]
                    if row_domain == dom:
                        r["email"] = "no_email_found"
                        r["status"] = "Skipped"
                        print(f"[Pipeline] No email found for '{r['company_name']}'. Marking as Skipped.")
                        break
                    
    save_queue(queue)
    print(f"[Pipeline] Scraping complete. Updated {updated_count} companies with email addresses.")

def run_generate_letters():
    """
    Generates tailored cover letter PDFs for companies in the queue 
    that have emails populated and status is Pending or Approved.
    """
    if not os.path.exists(LETTERS_DIR):
        os.makedirs(LETTERS_DIR)
        
    queue = load_queue()
    target_rows = [r for r in queue if r["email"] and r["status"] in ["Pending", "Approved"]]
    
    if not target_rows:
        print("[Pipeline] No companies in queue with emails that need cover letters generated.")
        return
        
    print(f"[Pipeline] Generating cover letters for {len(target_rows)} companies...")
    for r in target_rows:
        safe_name = r["company_name"].replace(" ", "_").replace("/", "_").replace(".", "")
        pdf_path = os.path.join(LETTERS_DIR, f"Abraham_Gyamfi_Cover_Letter_{safe_name}.pdf")
        
        generator.generate_pdf(
            company_name=r["company_name"],
            role_title="DevOps & Cloud Engineer",
            company_type=r["company_type"],
            recipient_name=r["recipient_name"],
            company_address=r["company_address"],
            output_path=pdf_path
        )
    print("[Pipeline] Cover letter generation complete.")

# Maps short company names to pre-generated cover letter files (Annin Kakra Afriyie profile).
_LETTER_MAP = {
    "gridco": "Cover_Letter_GRIDCo.pdf",
    "volta river authority": "Cover_Letter_VRA.pdf",
    "bui power authority": "Cover_Letter_Bui_Power.pdf",
    "cenpower": "Cover_Letter_Cenpower.pdf",
    "early power": "Cover_Letter_Early_Power.pdf",
    "sunon asogli": "Cover_Letter_Sunon_Asogli.pdf",
}

def _resolve_letter_path(r):
    """Return the cover letter PDF path for a queue row (company_name -> file)."""
    if not os.path.exists(LETTERS_DIR):
        return None
    n = (r["company_name"] or "").lower()
    for key, fname in _LETTER_MAP.items():
        if key in n:
            p = os.path.join(LETTERS_DIR, fname)
            if os.path.exists(p):
                return p
    safe_name = r["company_name"].replace(" ", "_").replace("/", "_").replace(".", "")
    for cand in (
        f"Cover_Letter_{safe_name}.pdf",
        f"Sample_Cover_Letter_{safe_name}.pdf",
        f"Abraham_Gyamfi_Cover_Letter_{safe_name}.pdf",
    ):
        p = os.path.join(LETTERS_DIR, cand)
        if os.path.exists(p):
            return p
    return None

def _generate_my_letter(r, output_path):
    """Generate a cover letter PDF using Annin Kakra Afriyie's profile."""
    from generate_my_letters import build_letter
    if not os.path.exists(LETTERS_DIR):
        os.makedirs(LETTERS_DIR)
    build_letter(
        company_name=r["company_name"],
        sector="power",
        recipient=r["recipient_name"] or "The Recruiting Team",
        address=r["company_address"] or "Accra, Ghana",
        role_title="Electrical & Electronic Engineer",
        output_path=output_path,
    )

def run_send_emails():
    """
    Sends emails to companies marked "Approved" in the queue.
    Obeys a target limit (e.g. 15 per day) and standard delay.
    """
    queue = load_queue()
    approved = [r for r in queue if r["status"] == "Approved" and r["email"]]
    
    if not approved:
        print("[Pipeline] No emails marked 'Approved' in queue. Change 'Pending' to 'Approved' in outreach_queue.csv first.")
        return
        
    limit = 15
    to_send = approved[:limit]
    print(f"[Pipeline] Starting outreach run: sending {len(to_send)} of {len(approved)} approved emails...")
    
    sender_service = get_sender()
    sent_count = 0
    failed_count = 0
    
    for i, r in enumerate(to_send):
        # Resolve a pre-generated cover letter, else generate one on the fly
        letter_path = _resolve_letter_path(r)
        if letter_path is None:
            print(f"[Pipeline] Cover letter PDF missing for {r['company_name']}. Generating on the fly...")
            safe_name = r["company_name"].replace(" ", "_").replace("/", "_").replace(".", "")
            letter_path = os.path.join(LETTERS_DIR, f"Cover_Letter_{safe_name}.pdf")
            _generate_my_letter(r, letter_path)
            
        # Send
        success = sender_service.send_outreach_email(
            recipient_email=r["email"],
            company_name=r["company_name"],
            cover_letter_path=letter_path,
            cv_path=CV_PATH,
            role_title="Electrical & Electronic Engineer"
        )
        
        if success:
            r["status"] = "Sent"
            r["date_sent"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            sent_count += 1
            log_outreach(r, "SUCCESS")
        else:
            r["status"] = "Failed"
            failed_count += 1
            log_outreach(r, "FAILED")
            
        save_queue(queue)
        
        # Random delay between emails (30 to 60 seconds) to bypass spam filters
        if i < len(to_send) - 1:
            delay = random.randint(30, 60)
            print(f"[Pipeline] Waiting {delay} seconds before sending next email...")
            time.sleep(delay)
            
    print(f"[Pipeline] Run complete. Sent: {sent_count}, Failed: {failed_count}.")

def log_outreach(row, status):
    """
    Logs successful or failed emails to outreach_log.csv
    """
    fields = ["date", "company_name", "email", "status", "cover_letter"]
    write_header = not os.path.exists(LOG_FILE)
    
    with open(LOG_FILE, "a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        if write_header:
            writer.writeheader()
            
        safe_name = row["company_name"].replace(" ", "_").replace("/", "_").replace(".", "")
        letter_file = f"Abraham_Gyamfi_Cover_Letter_{safe_name}.pdf"
        
        writer.writerow({
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "company_name": row["company_name"],
            "email": row["email"],
            "status": status,
            "cover_letter": letter_file
        })

def show_status():
    """
    Prints stats of the queue
    """
    queue = load_queue()
    stats = {"Pending": 0, "Approved": 0, "Sent": 0, "Failed": 0, "Skipped": 0}
    no_email = 0
    
    for r in queue:
        stats[r["status"]] = stats.get(r["status"], 0) + 1
        if not r["email"]:
            no_email += 1
            
    print("\n--- Outreach Queue Status ---")
    print(f"Total Companies in Queue: {len(queue)}")
    print(f"  Pending:  {stats['Pending']} (of which {no_email} have no email address)")
    print(f"  Approved: {stats['Approved']} (ready to send)")
    print(f"  Sent:     {stats['Sent']}")
    print(f"  Failed:   {stats['Failed']}")
    print(f"  Skipped:  {stats['Skipped']}")
    print("-----------------------------\n")

def print_help():
    print("""
Usage: py outreach_pipeline.py [command]

Commands:
  import    - Import unhyped companies from unhyped_ghana_tech_employers.md
  search    - Search Exa for new tech companies (args: query [limit])
              e.g., py outreach_pipeline.py search "fintech companies in Accra Ghana" 10
  scrape    - Crawl websites of Pending companies using Apify to harvest contact emails
  generate  - Compile ReportLab cover letter PDFs for companies with emails in the queue
  send      - Send up to 15 emails marked 'Approved' via SMTP with CV & Letter attachments
  status    - Show queue statistics and counts
""")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print_help()
        sys.exit(0)
        
    cmd = sys.argv[1].lower()
    
    if cmd == "import":
        import_unhyped_employers()
    elif cmd == "search":
        q = "tech startup software development company Accra Ghana"
        lim = 15
        if len(sys.argv) > 2:
            q = sys.argv[2]
        if len(sys.argv) > 3:
            lim = int(sys.argv[3])
        run_exa_search(q, lim)
    elif cmd == "scrape":
        run_apify_scrape()
    elif cmd == "generate":
        run_generate_letters()
    elif cmd == "send":
        run_send_emails()
    elif cmd == "status":
        show_status()
    else:
        print(f"Unknown command: {cmd}")
        print_help()
