---
name: pdf-processing
description: "Process PDF files — read, extract text, merge, split, create, fill forms, OCR. Trigger when user mentions PDF files or needs to work with PDFs."
version: "1.0.0"
author: "Commander Team"
license: "MIT"
argument-hint: <file.pdf> or <action>
allowed-tools: python_execute shell_execute file_read file_write file_edit
metadata:
  category: coding
  tags: [pdf, python, document-processing, ocr]
  source: community
  quality_score: 0.85
---

# PDF Processing Guide

Use Python libraries to process PDF files. This skill covers common PDF operations.

## Required Libraries

Install if not available:
```bash
pip install pypdf pymupdf pdfplumber reportlab
```

## Quick Reference

### Read PDF and Extract Text
```python
from pypdf import PdfReader

reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

for i, page in enumerate(reader.pages):
    text = page.extract_text()
    print(f"--- Page {i+1} ---")
    print(text[:500])
```

### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

### Split PDF
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

### Extract Tables (pdfplumber)
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                print(row)
```

### Create PDF (reportlab)
```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

c = canvas.Canvas("output.pdf", pagesize=letter)
c.setFont("Helvetica", 12)
c.drawString(72, 720, "Hello, World!")
c.save()
```

### OCR Scanned PDFs
```python
import subprocess

# Using ocrmypdf (install: pip install ocrmypdf)
subprocess.run(["ocrmypdf", "input.pdf", "output.pdf"], check=True)
```

## Decision Guide

| Task | Library | Approach |
|------|---------|----------|
| Extract text | pypdf | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Merge/split | pypdf | PdfWriter + add_page |
| Fill forms | pypdf | `writer.update_page_form_field_values()` |
| Create new | reportlab | canvas.Canvas |
| OCR | ocrmypdf | CLI tool |

## Error Handling

- **File not found**: Check path, suggest `file_list` to find files
- **Encrypted PDF**: Try `reader.decrypt("password")`
- **Empty text extraction**: PDF may be scanned — suggest OCR
- **Library not installed**: Run `pip install <library>`
