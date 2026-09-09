import os
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable
from reportlab.lib import colors

class CoverLetterGenerator:
    def __init__(self):
        # Palette colors matching the corporate style
        self.primary_color = colors.HexColor("#77216F") # Purple
        self.secondary_color = colors.HexColor("#E95420") # Orange/Warm red
        self.dark_color = colors.HexColor("#1a1a1a")
        self.mid_color = colors.HexColor("#2b2b2b")
        self.gray_color = colors.HexColor("#555555")

    def _get_styles(self):
        def S(name, font, size, **kw):
            return ParagraphStyle(name, fontName=font, fontSize=size, leading=size * 1.45, **kw)
            
        return {
            "name": S("N", "Helvetica-Bold", 17, textColor=self.dark_color, spaceAfter=1),
            "sub": S("Sub", "Helvetica-Bold", 10, textColor=self.primary_color, spaceAfter=2),
            "contact": S("C", "Helvetica", 8.5, textColor=self.gray_color, spaceAfter=2),
            "meta": S("M", "Helvetica", 9.5, textColor=self.gray_color, spaceAfter=2),
            "body": S("B", "Helvetica", 10, textColor=self.mid_color, alignment=TA_JUSTIFY, spaceAfter=7),
            "sign": S("Sg", "Helvetica", 10, textColor=self.mid_color, spaceAfter=0)
        }

    def get_template_paragraphs(self, company_name, role_title, company_type):
        """
        Returns paragraphs of text customized by company type.
        """
        paragraphs = []
        
        # Paragraph 1: Introduction
        p1 = (
            f"I am writing to express my strong interest in the {role_title} position at {company_name}. "
            f"As a DevOps Engineer at AmaliTech with a Computer Science background from KNUST, an AWS Certified Solutions Architect – Associate, "
            f"and hands-on experience provisioning AWS infrastructure with Terraform and CloudFormation, I have built my foundation on "
            f"core cloud systems, CI/CD automation, and Infrastructure as Code. I am eager to bring my technical expertise, "
            f"operational rigor, and adaptability to your engineering team."
        )
        paragraphs.append(p1)
        
        # Paragraph 2 & bullet points based on company type
        if company_type == "consultancy":
            p2 = (
                "While my production experience at AmaliTech has been built primarily on AWS cloud systems, "
                "the principles of infrastructure automation and operations are universal. I bring skills that "
                "transfer directly to client engagements across cloud environments:"
            )
            b1 = "<b>&bull;&#160;&#160;Infrastructure as Code:</b> I write modular Terraform and CloudFormation to provision highly available AWS infrastructure (EC2, RDS, DynamoDB, S3, EKS, Lambda, ECS), reducing manual environment setup time."
            b2 = "<b>&bull;&#160;&#160;Kubernetes Orchestration:</b> I deploy, manage, and scale containerized workloads on Kubernetes (Amazon EKS), configuring Deployments, Services, Ingress, ConfigMaps, Secrets, and Horizontal Pod Autoscalers to support resilient, highly available applications."
            b3 = "<b>&bull;&#160;&#160;Observability:</b> My experience building monitoring and logging architectures with AWS CloudWatch, Prometheus, and Grafana has meaningfully improved system visibility and reduced Mean Time To Resolution (MTTR)."
            bullets = [b1, b2, b3]

        elif company_type == "fintech":
            p2 = (
                "Operating transactional software and fintech backends requires reliability, consistency, and disciplined "
                "deployment practices. I bring production experience building CI/CD pipelines and containerized cloud systems:"
            )
            b1 = "<b>&bull;&#160;&#160;Automated CI/CD:</b> I design and maintain Jenkins-based CI/CD pipelines that integrate security testing, streamlining deployment workflows and accelerating release cycles."
            b2 = "<b>&bull;&#160;&#160;Container Orchestration:</b> I containerize microservices using Docker and deploy, manage, and scale them on Kubernetes (Amazon EKS), ensuring high availability and reliable deployments across staging and production environments."
            b3 = "<b>&bull;&#160;&#160;Infrastructure Automation:</b> I automate routine infrastructure maintenance and operational workflows using Bash and Python, reducing manual overhead and minimizing human error."
            bullets = [b1, b2, b3]

        elif company_type == "telecom" or company_type == "isp":
            p2 = (
                "Telecom and ISP systems rely heavily on robust cloud infrastructure and proactive system monitoring. "
                "I bring a strong engineering foundation in AWS infrastructure, containerization, and observability:"
            )
            b1 = "<b>&bull;&#160;&#160;AWS Infrastructure:</b> I architect and provision highly available AWS infrastructure (EC2, RDS, DynamoDB, S3, EKS, Lambda, ECS) using modular Terraform and CloudFormation."
            b2 = "<b>&bull;&#160;&#160;Kubernetes Orchestration:</b> I deploy, manage, and scale containerized workloads on Kubernetes (Amazon EKS), configuring Deployments, Services, Ingress, ConfigMaps, Secrets, and Horizontal Pod Autoscalers for resilient, highly available applications."
            b3 = "<b>&bull;&#160;&#160;Systems Monitoring:</b> I implement monitoring and logging architectures using AWS CloudWatch, Prometheus, and Grafana, improving system visibility and reducing Mean Time To Resolution (MTTR)."
            bullets = [b1, b2, b3]

        elif company_type == "bank":
            p2 = (
                "Financial environments demand disciplined operations and rapid incident visibility. "
                "I bring experience maintaining cloud systems and building observability into infrastructure:"
            )
            b1 = "<b>&bull;&#160;&#160;Monitoring & Incident Visibility:</b> I implement monitoring and logging architectures using AWS CloudWatch, Prometheus, and Grafana, improving system visibility and reducing Mean Time To Resolution (MTTR)."
            b2 = "<b>&bull;&#160;&#160;Infrastructure as Code:</b> I provision AWS infrastructure using modular Terraform and CloudFormation, reducing manual environment setup time and configuration drift."
            b3 = "<b>&bull;&#160;&#160;Operational Discipline:</b> I automate routine infrastructure maintenance using Bash and Python, reducing manual operational overhead and minimizing human error."
            bullets = [b1, b2, b3]

        else: # startup / general product hunt
            p2 = (
                "In fast-growing startups, balancing engineering velocity and system reliability is critical. "
                "I bring automation-first skills that directly support that goal:"
            )
            b1 = "<b>&bull;&#160;&#160;Infrastructure Velocity:</b> My modular Terraform and CloudFormation code provisions highly available AWS infrastructure (EC2, RDS, DynamoDB, S3, EKS, Lambda, ECS), reducing manual environment setup time."
            b2 = "<b>&bull;&#160;&#160;Kubernetes Orchestration:</b> I deploy, manage, and scale containerized workloads on Kubernetes (Amazon EKS), configuring Deployments, Services, Ingress, ConfigMaps, Secrets, and Horizontal Pod Autoscalers for resilient, highly available applications."
            b3 = "<b>&bull;&#160;&#160;Continuous Delivery:</b> I design and maintain automated CI/CD pipelines using Jenkins, integrating security testing to streamline deployment workflows and accelerate release cycles."
            bullets = [b1, b2, b3]
            
        paragraphs.append(p2)
        paragraphs.extend(bullets)
        
        # Paragraph 3: Closing
        p3 = (
            f"Thank you for your time and consideration. I would welcome the opportunity to discuss how my DevOps skills, "
            f"automation drive, and adaptability can support the technology initiatives at {company_name}."
        )
        paragraphs.append(p3)
        
        return paragraphs

    def generate_pdf(self, company_name, role_title, company_type, recipient_name, company_address, output_path):
        """
        Generates a professionally styled PDF cover letter.
        """
        doc = SimpleDocTemplate(
            output_path, pagesize=A4,
            leftMargin=0.85 * inch, rightMargin=0.85 * inch,
            topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        )
        
        styles = self._get_styles()
        story = []
        
        # Letterhead
        story.append(Paragraph("ABRAHAM GYAMFI", styles["name"]))
        story.append(Paragraph("DevOps Engineer &ndash; AWS Certified Solutions Architect – Associate", styles["sub"]))
        story.append(Paragraph(
            "+233 55 784 9795&#160;&#160;|&#160;&#160;gyamfiabraham95@gmail.com&#160;&#160;|&#160;&#160;"
            f'<a href="https://www.linkedin.com/in/opoku-gyamfi-abraham-959980392" color="{self.primary_color.hexval()}">'
            "linkedin.com/in/opoku-gyamfi-abraham</a>&#160;&#160;|&#160;&#160;"
            f'<a href="https://github.com/AbrahamGyamfi" color="{self.primary_color.hexval()}">'
            "github.com/AbrahamGyamfi</a>&#160;&#160;|&#160;&#160;Kumasi, Ghana",
            styles["contact"]
        ))
        
        # Orange divider
        story.append(HRFlowable(width="100%", thickness=1.5, color=self.secondary_color, spaceAfter=8, spaceBefore=4))
        
        # Date & Addressee
        date_str = datetime.now().strftime("%d %B %Y")
        story.append(Paragraph(date_str, styles["meta"]))
        story.append(Spacer(1, 4))
        story.append(Paragraph(recipient_name, styles["meta"]))
        story.append(Paragraph(company_name, styles["meta"]))
        if company_address:
            story.append(Paragraph(company_address, styles["meta"]))
        story.append(Spacer(1, 8))
        
        # Salutation
        salutation_name = recipient_name.strip()
        words = salutation_name.split()
        generic_keywords = ["team", "manager", "recruiting", "talent", "acquisition", "hr", "resources", "hiring", "services", "solutions", "technology", "tech"]
        is_generic = any(k in salutation_name.lower() for k in generic_keywords)
        
        if not is_generic and len(words) >= 2:
            first = words[0]
            last = words[-1]
            if first.lower() in ["mr", "mr.", "ms", "ms.", "mrs", "mrs.", "dr", "dr.", "prof", "prof."]:
                salutation_name = f"{first} {last}"
            else:
                salutation_name = first
                
        story.append(Paragraph(f"Dear {salutation_name},", styles["body"]))
        
        # Body Paragraphs
        body_paras = self.get_template_paragraphs(company_name, role_title, company_type)
        for p in body_paras:
            story.append(Paragraph(p, styles["body"]))
            
        # Sign-off
        story.append(Spacer(1, 6))
        story.append(Paragraph("Sincerely,", styles["sign"]))
        story.append(Spacer(1, 4))
        story.append(Paragraph("<b>Abraham Gyamfi</b>", styles["sign"]))
        story.append(Paragraph("DevOps Engineer &ndash; AWS Certified Solutions Architect – Associate", styles["contact"]))
        
        doc.build(story)
        print(f"[Generator] Generated cover letter PDF at: {output_path}")
        return output_path
