# OB2 Use Cases

## 1. Military Veteran: Querying Service Records

**The situation:** A veteran has decades of paperwork — DD214s, medical evaluation board findings, service treatment records, VA correspondence, and discharge papers. Many are scanned photocopies or faxed carbon copies, not clean PDFs. When filing a disability claim or appeal, finding the right document and the right page takes hours.

**With OB2:**

```bash
# Upload service records via the dashboard (drag and drop)
# OCR runs automatically on scanned PDFs — no manual prep needed

# Ask questions from the chat interface or Claude Code
"What was my MOS and unit during my 2004-2006 deployment?"
-> Sources: DD214 (2006), deployment orders (2004)
   [Click to view original PDF]

"What conditions were noted in my separation physical?"
-> Sources: separation medical exam (2006-08-15)
   [Click to view original PDF]

"Which letters from the VA reference my hearing loss claim?"
-> Sources: VA decision letter (2019-03), VA response (2021-07)
```

**What makes it work:** OB2's OCR pipeline uses `ocrmypdf` with the Tesseract LSTM model at 300 DPI with deskew and rotation correction. A DD214 scanned sideways at 150 DPI on a home scanner comes out correctly extracted. Original files are stored and downloadable — you always have the source, not just the extracted text.

Nothing leaves your laptop.

---

## 2. School District: Curriculum and Policy Management

**The situation:** A district maintains hundreds of documents: curriculum frameworks, board policies, student handbook, staff contracts, special education procedures, and annual updates to all of the above. Staff frequently need to answer questions like "what is the policy on field trip approvals?" or "what are the IEP timeline requirements under IDEA?" The documents are spread across shared drives and PDFs that change every year.

**With OB2:**

```bash
# Import the policy library and curriculum docs
# (drag and drop in dashboard, or CLI for batch upload)

# Staff ask questions via the chat interface (--with-chat flag)
"What is the policy for approving overnight field trips?"
-> "Overnight trips require board approval 60 days in advance...
   [Source: field-trips-policy-2025-26.pdf — click to view]"

"What are the IDEA timeline requirements for initial IEP evaluation?"
-> "The district must complete evaluation within 60 calendar days...
   [Source: sped-procedures-2025.pdf]"
```

**Multi-user, per-domain setup:** HR docs in `@hr-policy`, curriculum in `@curriculum`, special ed procedures in `@sped`. Teachers get read access to `@curriculum` and `@sped`. HR staff get write access to `@hr-policy`. Admins get read everywhere. Sensitive HR documents are never visible to staff without permission.

Student data never touched. The entire system runs on a district server.

---

## 3. Security Team: Runbook Knowledge Base

**The situation:** A security team has playbooks for incident response, runbooks for certificate management, SOC procedures, and firewall change policies. They're split between Confluence, Git repos, and local Markdown files. During an incident at 3 AM, nobody wants to search Confluence. They want to type a question and get the procedure.

**With OB2:**

```bash
# One-time: import security runbooks from Git
python -m cli.import_cmd docs \
  --domain netsec \
  --dir ./security-runbooks/ \
  --recursive \
  --tags oncall soc

# From Claude Code during an incident:
@netsec what are the first steps when a certificate expires in prod?
-> "1. Identify the service via the certificate inventory...
   2. Generate a new CSR on the target host...
   [Source: cert-rotation.md — click to view]"

@netsec what is the SEV1 escalation path?
-> "Page the on-call SRE via PagerDuty policy 'security-sev1'...
   [Source: incident-response.md#escalation]"
```

**Real-time updates:** When a runbook changes, re-import it. Source-hash dedup skips unchanged files. Changed files are re-embedded and available immediately (after the 5-second sync to pgvector).

The team captures ad-hoc knowledge too:

```
@netsec remember: CVE-2024-1234 affects OpenSSL < 3.2.1 — patch by Friday
```

That fact is embedded, stored, and searchable within 100 ms.

---

## 4. Legal Team: Case File Knowledge Base

**The situation:** A litigation team has thousands of pages of deposition transcripts, contract histories, expert reports, and correspondence for each case. Cases span years. Associates spend hours tracking down which exhibit mentioned a specific date or clause.

**With OB2:**

```bash
# Import case files per matter, per domain
python -m cli.import_cmd pdf \
  --domain matter-2024-07 \
  --file deposition-transcript-jones.pdf \
  --tags deposition witness

python -m cli.import_cmd pdf \
  --domain matter-2024-07 \
  --file contract-amendment-3.pdf \
  --tags contract amendment

# Associates ask questions:
"Which deposition mentions the 2023 contract amendment?"
-> "Jones deposition (p. 47): 'the amendment signed in March 2023...'
   [Source: deposition-transcript-jones.pdf — click to view]"

"What indemnification language appears in the original contract?"
-> "Section 12.3: 'Vendor shall indemnify and hold harmless...'
   [Source: master-services-agreement.pdf — click to view]"
```

**Per-matter isolation:** Each case gets its own domain. Associates have read access only to the matters they're working. Partners have admin access to all. Client documents never touch a cloud service.

---

## 5. Researcher: Literature Review

**The situation:** A researcher has accumulated 400 PDFs across a decade of study on a topic. Some are scanned conference proceedings. Others are born-digital. They need to answer questions like "which papers propose method X" or "what year did Y first appear in the literature" — the kind of question that would take a day of manual searching.

**With OB2:**

```bash
# Bulk import the PDF library
python -m cli.import_cmd pdf \
  --domain research \
  --dir ~/papers/ \
  --tags literature

# Later, individual adds:
# Dashboard -> Domains -> @research -> drag-drop new PDFs

# Ask cross-paper questions:
"Which papers discuss transformer attention as a retrieval mechanism?"
-> "Smith et al. (2021): 'We treat attention weights as...'
   Jones & Lee (2022): 'building on the retrieval interpretation of...'
   [Sources: smith-2021-attention.pdf, jones-lee-2022.pdf]"

"When did the term 'grounding' first appear in these papers?"
-> "First appearance: Chen 2019 (p. 3): 'grounding the response in...'
   [Source: chen-2019-grounded.pdf — click to view]"
```

**Citation links** are the key feature here: every answer includes a clickable link to the original PDF. The researcher can immediately verify the context without leaving the chat.

---

## 6. Security Team: High-Throughput Bulk Ingest (Rust Sidecar)

**The situation:** A team is migrating from a legacy knowledge management system. They have 50,000 documents to index over a weekend. Throughput matters — every hour of indexing time is an hour the team can't answer questions.

**With OB2 and the Rust sidecar:**

```bash
export OB2_SIDECAR_RUNTIME=rust
scripts/docker-start.sh --build

# Same import commands, significantly faster
python -m cli.import_cmd docs \
  --domain knowledge-base \
  --dir ./legacy-export/ \
  --recursive
```

**Measured on RTX 5090:**
- 1,124 concurrent captures/sec vs 281 on Python (4x)
- 0.36 s cold start vs 4.63 s (no 5-second warmup penalty on restart)
- 687 MB sidecar RSS vs 1,396 MB (2x less RAM)

Same data, same queries, same result quality — just faster. Toggle back with `OB2_SIDECAR_RUNTIME=` and no data migration is needed.

---

## Summary by Industry

| Industry | Domain structure | Key feature used |
|---|---|---|
| **Veterans / government** | One domain per record type | OCR for scanned PDFs, original file download |
| **Education** | Per-department domains | Multi-user ACL, department-scoped access |
| **Security / SRE** | Per-function domains | MCP integration with Claude Code, fast capture |
| **Legal** | Per-matter domains | Strict per-domain isolation, citation links |
| **Research** | One or few large domains | Cross-document queries, PDF citation links |
| **Enterprise IT** | Per-team domains | Bulk import CLI, high-throughput Rust sidecar |

All cases: data stays on your hardware, answers cite sources, and citations link back to the original document.
