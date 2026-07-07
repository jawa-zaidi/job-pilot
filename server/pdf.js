// Render the tailored plain-text CV as a clean PDF so applications carry a
// real attachment instead of CV text pasted under the email body.
const PDFDocument = require('pdfkit');

// Heuristic: ALL-CAPS short lines are section headers ("EXPERIENCE", "SKILLS").
function isHeader(line) {
  const t = line.trim();
  return t.length > 1 && t.length <= 40 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/[a-z]/.test(t);
}

function cvToPdfBuffer(cvText, { name = '' } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 46, bottom: 46, left: 50, right: 50 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const lines = String(cvText || '').replace(/\r/g, '').split('\n');
    let first = true;
    for (const line of lines) {
      const t = line.trimEnd();
      if (!t.trim()) { doc.moveDown(0.4); continue; }
      if (first) {
        // First non-empty line is usually the candidate's name — make it the title
        doc.font('Helvetica-Bold').fontSize(16).fillColor('#111').text(t.trim());
        doc.moveDown(0.3);
        first = false;
        continue;
      }
      if (isHeader(t)) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(t.trim());
        doc.moveTo(doc.x, doc.y + 1).lineTo(doc.page.width - 50, doc.y + 1).lineWidth(0.5).strokeColor('#999').stroke();
        doc.moveDown(0.25);
      } else {
        doc.font('Helvetica').fontSize(9.5).fillColor('#222').text(t, { lineGap: 1.5 });
      }
    }
    doc.end();
  });
}

// Safe, recognizable filename: "Backend Engineer - Acme - Jane Doe CV.pdf"
// Role first — the name is the same on every file, the role is what tells
// you which one to upload when the platform's file dialog opens.
function cvFileName(name, company, title) {
  const clean = (s, n) => String(s || '').replace(/[^\w .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
  const parts = [clean(title, 44), clean(company, 30), clean(name, 30)].filter(Boolean);
  return (parts.length ? parts.join(' - ') : 'CV') + ' CV.pdf';
}

module.exports = { cvToPdfBuffer, cvFileName };
