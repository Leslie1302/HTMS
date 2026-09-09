import smtplib
import ssl
import os
from email.message import EmailMessage
from config import config

class EmailSender:
    def __init__(self):
        self.sender_email = config.get("SENDER_EMAIL")
        self.password = config.get("GMAIL_APP_PASSWORD")
        if not self.sender_email or not self.password:
            raise ValueError("SENDER_EMAIL or GMAIL_APP_PASSWORD is missing in configuration.")
            
    def send_outreach_email(self, recipient_email, company_name, cover_letter_path, cv_path, role_title="DevOps & Cloud Engineer"):
        """
        Sends an outreach email with the CV and cover letter attached.
        """
        if not recipient_email:
            print("[EmailSender] Error: Recipient email is empty.")
            return False
            
        msg = EmailMessage()
        msg["From"] = self.sender_email
        msg["To"] = recipient_email
        msg["Subject"] = f"Application - Electrical & Electronic Engineer - Annin Kakra Afriyie"

        # Email body (highly professional and brief)
        body = (
            f"Dear Recruiting Team at {company_name},\n\n"
            f"I hope this email finds you well.\n\n"
            f"My name is Annin Kakra Afriyie. I am a BSc Electrical and Electronic Engineering graduate of the "
            f"University of Mines and Technology (UMaT), currently serving at the Power Directorate of the Ministry of "
            f"Energy and Green Transition, with practical experience from the Electricity Company of Ghana (ECG).\n\n"
            f"I am writing to express my strong interest in Electrical, Power Systems and Control/Automation opportunities "
            f"at {company_name}. To share details on how my background aligns with your work, I have attached my CV and a "
            f"tailored cover letter.\n\n"
            f"Some highlights of my background include:\n"
            f"- Supporting monitoring and analysis of national power system operations at the Ministry of Energy (Power Directorate).\n"
            f"- Practical distribution experience at ECG: transformer testing, load monitoring, low-voltage network fault diagnosis.\n"
            f"- Final-year project: AI-integrated IoT system for real-time groundwater quality monitoring (sensor networks + machine learning).\n"
            f"- Skills in power systems, control circuits, instrumentation, and tools including MATLAB, Proteus, and AutoCAD.\n\n"
            f"I would welcome the opportunity to speak with a member of your team or engineering leads about how my "
            f"electrical engineering knowledge and commitment to safety and quality can add value to {company_name}.\n\n"
            f"Thank you for your time and consideration.\n\n"
            f"Best regards,\n\n"
            f"Annin Kakra Afriyie\n"
            f"Accra, Ghana\n"
            f"Phone: (+233) 50-966-2241\n"
            f"Email: annink6@gmail.com\n"
            f"LinkedIn: https://www.linkedin.com/in/annin-kakra-50570\n"
        )
        msg.set_content(body)
        
        # Attach Cover Letter
        if os.path.exists(cover_letter_path):
            with open(cover_letter_path, "rb") as f:
                file_data = f.read()
                file_name = os.path.basename(cover_letter_path)
            msg.add_attachment(file_data, maintype="application", subtype="pdf", filename=file_name)
        else:
            print(f"[EmailSender] Error: Cover letter path {cover_letter_path} does not exist.")
            return False
            
        # Attach CV
        if os.path.exists(cv_path):
            with open(cv_path, "rb") as f:
                file_data = f.read()
                file_name = os.path.basename(cv_path)
            msg.add_attachment(file_data, maintype="application", subtype="pdf", filename=file_name)
        else:
            print(f"[EmailSender] Error: CV path {cv_path} does not exist.")
            return False
            
        # Send email
        context = ssl.create_default_context()
        try:
            print(f"[EmailSender] Connecting to SMTP server to email {recipient_email}...")
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as smtp:
                smtp.login(self.sender_email, self.password)
                smtp.sendmail(self.sender_email, recipient_email, msg.as_string())
            print(f"[EmailSender] Successfully sent email to {recipient_email}")
            return True
        except Exception as e:
            print(f"[EmailSender] SMTP Error sending to {recipient_email}: {e}")
            return False
