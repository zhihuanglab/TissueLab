# TissueLab Privacy Policy

**Effective date:** June 5, 2026
**Last updated:** June 5, 2026

This Privacy Policy describes how the Zhi Huang Lab at the Department of Pathology and Laboratory Medicine, Perelman School of Medicine, University of Pennsylvania ("TissueLab", "we") collects, uses, discloses, and protects information when you use the TissueLab web platform, desktop application, APIs, models, and related services (the "Service"). TissueLab is a research preview and is registered as an innovation with the Penn Center for Innovation ("PCI").

For how we handle model training and behavioral data, including your controls, see Section 5.

---

## 1. Who we are

TissueLab is the data controller for personal data processed in connection with the Service.

Contact: [zhi.huang@pennmedicine.upenn.edu](mailto:zhi.huang@pennmedicine.upenn.edu)
Postal: Zhi Huang Lab, 3700 Hamilton Walk, D204, Philadelphia, PA 19104

---

## 2. Information we collect

### 2.1 Account information
Name, email, professional role, institution, country, password hash, and any optional profile information you provide.

### 2.2 Whole Slide Images and annotations (User Content)
WSIs you upload to TissueLab servers and any annotations you create. For the desktop app, WSIs you process locally are **not** transmitted to TissueLab servers unless you explicitly upload or sync them.

### 2.3 Behavioral / telemetry data
Events such as which slides you open, zoom and pan actions, tools invoked, models and workflows run, parameters chosen, annotations made, time on task, errors encountered, device type, OS, and approximate (city-level) location derived from IP address.

We separately label whether each behavioral event occurred on (a) a public dataset slide or (b) a private slide, so that we can honor the differing consent defaults described in Section 5.

### 2.4 Technical and security data
IP address, session identifiers, browser/app version, authentication logs, security event logs.

### 2.5 Communications
Support tickets, emails, in-app messages.

### 2.6 Cookies and similar technologies
See Section 11.

### 2.7 Information we do **not** want
Please do not upload Protected Health Information (PHI), other patient-identifiable information, or other sensitive personal data unless your institution has executed a Business Associate Agreement with TissueLab and the data is uploaded through channels designated for PHI.

---

## 3. How we use information

| Purpose | Categories used | Lawful basis (GDPR) |
|---|---|---|
| Provide and operate the Service | All categories | Contract |
| Authenticate users, prevent fraud and abuse | Account, Technical | Legitimate interests; legal obligation |
| Customer support | Account, Communications, Behavioral (limited) | Contract; legitimate interests |
| Service improvement and analytics (aggregated/de-identified) | Behavioral, Technical | Legitimate interests |
| Train and fine-tune TissueLab models, classifiers, and workflows from behavioral data | Behavioral (per consent rules in Sec. 5) | **Consent** |
| Train and fine-tune from image pixels of private WSIs | User Content | **Explicit separate written consent / institutional agreement** only |
| Legal compliance, defense of legal claims | Any necessary | Legal obligation; legitimate interests |
| Security incident response | Technical, Behavioral | Legitimate interests; legal obligation |
| Marketing communications about TissueLab features | Account | Consent (you can unsubscribe) |

---

## 4. How models, classifiers, and workflows fit in

The Service exposes:

- **Foundation models** (in-house or third-party)
- **Classifiers** fine-tuned on top of those models (e.g., linear probes, gradient-boosted heads)
- **Customized models** = foundation model + classifier
- **Workflows** that orchestrate one or more of the above, either user-assembled or built by TissueLab's agentic AI workflow builder

Some of these are improved over time using data collected from the Service. The categories of data that may be used for improvement, and the user controls, are described in Section 5.

Ownership of the resulting models, classifiers, and workflows is addressed in the Terms of Service (Section 6).

---

## 5. The opt-in / opt-out split for behavioral data

We treat behavioral data differently depending on which type of slide you were viewing when the events were generated:

### 5.1 Public datasets (TCGA, PathAI public sets, etc.) — opt-IN by default
By default, behavioral events generated while you browse public datasets may be used to (a) improve the Service and (b) train, fine-tune, and evaluate TissueLab models, classifiers, and workflows. You may opt out at any time in **Account → Privacy → "Improve TissueLab with my public-data activity"**.

### 5.2 Private slides (your uploaded or local-app WSIs) — opt-OUT by default
By default, behavioral events generated while you work on your own private WSIs are used **only** to operate the Service for you and are **not** used for model training or product improvement. You may opt in via **Account → Privacy → "Contribute my private-data activity to TissueLab model training"**, which requires explicit confirmation.

### 5.3 Image pixels of private WSIs — never without separate consent
We do not use the pixel content of your private WSIs to train or evaluate models without a separate, explicit written agreement (typically at the institutional level).

Withdrawing consent stops further use; it does not require us to retrain or roll back models already trained on previously collected data, but we will cease using your data for new training runs.

---

## 6. How we share information

We **do not sell** personal data.

We share data only as follows:

- **Sub-processors** that help us run the Service (cloud hosting, observability, support tooling). Each is bound by written contracts requiring confidentiality, security, and appropriate data protection terms. A current list is available on request.
- **Institutional collaborators** with whom you choose to share specific projects or annotations.
- **Legal disclosures** when required by law, subpoena, or to protect rights, safety, or property.
- **Business transfers** in connection with a merger, acquisition, reorganization, spin-off, or sale of assets — including transfer to a successor or spin-off entity that will continue to operate the Service — subject to confidentiality and the protections of this Policy.
- **Aggregated or de-identified data** that cannot reasonably be re-identified.

For PHI shared under a BAA, sharing is further restricted by the BAA terms.

---

## 7. International transfers

We are headquartered in the United States. If you access the Service from outside the United States, your data will be transferred to and processed in the United States and other countries where our sub-processors operate.

For EEA/UK users, we rely on Standard Contractual Clauses for international transfers. A copy is available on request.

---

## 8. Retention

| Category | Retention period |
|---|---|
| Account information | For the life of your account + 30 days after deletion |
| User Content (private WSIs) | Until you delete, or for the life of your account + 30 days |
| Behavioral data linked to your account | 24 months, then aggregated/de-identified |
| Behavioral data used (under consent) in a training corpus | The retention of the training corpus itself, which may be indefinite for model lineage and reproducibility purposes |
| Security logs | 12 months |

---

## 9. Your rights

Depending on your jurisdiction, you may have rights to:

- **Access** the personal data we hold about you
- **Correct** inaccurate data
- **Delete** your data ("right to be forgotten")
- **Restrict** or **object to** certain processing
- **Portability** of data you provided
- **Withdraw consent** at any time, prospectively
- **Lodge a complaint** with your supervisory authority

Submit requests to [zhi.huang@pennmedicine.upenn.edu](mailto:zhi.huang@pennmedicine.upenn.edu). We will respond within the timeframes required by applicable law (typically 30 days under GDPR; 45 days under CCPA).

We will not retaliate against you for exercising these rights.

### California residents
You have additional rights under the CCPA/CPRA, including the right to know categories of personal information collected, sold (we don't sell), or shared, and to limit use of sensitive personal information. Contact [zhi.huang@pennmedicine.upenn.edu](mailto:zhi.huang@pennmedicine.upenn.edu).

### EEA / UK residents
You may complain to your national data protection authority.

---

## 10. Security

We implement administrative, physical, and technical safeguards designed to protect your information, including encryption in transit (TLS 1.2+) and at rest, access controls, audit logging, vulnerability management, and personnel training. No system is 100% secure; we cannot guarantee absolute security.

Report suspected vulnerabilities to [zhi.huang@pennmedicine.upenn.edu](mailto:zhi.huang@pennmedicine.upenn.edu).

---

## 11. Cookies and similar technologies

We use strictly necessary cookies for authentication and session management. We use analytics cookies only with your consent (where required by law). See our [**Cookie Notice**](/legal#cookies) for details and controls.

---

## 12. Children

The Service is not directed to children under 18, and we do not knowingly collect personal data from them.

---

## 13. Changes to this Policy

We may update this Policy. Material changes will be notified at least 30 days in advance via email or in-app notice, and re-consent will be obtained where required by law.

---

**Contact:** [zhi.huang@pennmedicine.upenn.edu](mailto:zhi.huang@pennmedicine.upenn.edu) · Zhi Huang Lab · 3700 Hamilton Walk, D204, Philadelphia, PA 19104
