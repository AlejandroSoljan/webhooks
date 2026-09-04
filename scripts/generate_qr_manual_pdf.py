import re
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle,getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate,Frame,PageTemplate,Paragraph,Preformatted,Spacer,Table,TableStyle
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'docs/api/MANUAL_API_QR.md';OUT=ROOT/'output/pdf/Manual_API_QR_Asisto_v5.00.021.pdf';LOGO=ROOT/'static/logo-asisto-transparent.png';WIDTH=A4[0]-34*mm
NAVY=colors.HexColor('#06264A');TEAL=colors.HexColor('#00C7A5');PALE=colors.HexColor('#EAF4F6');INK=colors.HexColor('#102235');MUTED=colors.HexColor('#52677A');LINE=colors.HexColor('#C9D9E2')
def f(s):
 s=s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;');s=re.sub(r'`([^`]+)`',r'<font name="Courier">\1</font>',s);return re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',s)
b=getSampleStyleSheet();title=ParagraphStyle('title',parent=b['Title'],fontName='Helvetica-Bold',fontSize=21,leading=25,textColor=NAVY,spaceAfter=10);h1=ParagraphStyle('h1',parent=b['Heading1'],fontName='Helvetica-Bold',fontSize=14,leading=18,textColor=NAVY,spaceBefore=9,spaceAfter=5);body=ParagraphStyle('body',parent=b['BodyText'],fontSize=9,leading=12.6,textColor=INK,spaceAfter=5);bullet=ParagraphStyle('bullet',parent=body,leftIndent=12,firstLineIndent=-7);code=ParagraphStyle('code',fontName='Courier',fontSize=6.8,leading=9,textColor=INK,backColor=colors.HexColor('#F4F7F9'),borderColor=LINE,borderWidth=.5,borderPadding=7,spaceAfter=7);cell=ParagraphStyle('cell',parent=body,fontSize=7.2,leading=9.2,spaceAfter=0)
class Doc(BaseDocTemplate):
 def __init__(self):
  super().__init__(str(OUT),pagesize=A4,leftMargin=17*mm,rightMargin=17*mm,topMargin=30*mm,bottomMargin=18*mm,title='Manual API QR Asisto v5.00.021',author='Asisto');fr=Frame(self.leftMargin,self.bottomMargin,self.width,self.height,id='f',leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0);self.addPageTemplates(PageTemplate(id='p',frames=[fr],onPage=self.decorate))
 def decorate(self,c,d):
  w,h=A4;c.saveState();c.setFillColor(NAVY);c.rect(0,h-24*mm,w,24*mm,fill=1,stroke=0);c.drawImage(str(LOGO),16*mm,h-19*mm,width=25*mm,height=14*mm,preserveAspectRatio=True,anchor='w',mask='auto');c.setFillColor(colors.white);c.setFont('Helvetica-Bold',11);c.drawString(47*mm,h-11*mm,'ASISTO | DOCUMENTACION DE API');c.setFont('Helvetica',8);c.drawString(47*mm,h-16*mm,'Version 5.00.021');c.setStrokeColor(TEAL);c.setLineWidth(1.4);c.line(16*mm,h-25.5*mm,w-16*mm,h-25.5*mm);c.setStrokeColor(LINE);c.setLineWidth(.5);c.line(17*mm,13*mm,w-17*mm,13*mm);c.setFillColor(MUTED);c.setFont('Helvetica',7.5);c.drawString(17*mm,8.5*mm,'Asisto | API publica QR');c.drawRightString(w-17*mm,8.5*mm,f'Pagina {d.page}');c.restoreState()
def parse():
 ls=SRC.read_text(encoding='utf-8-sig').splitlines();out=[];para=[];cb=[];inc=False;i=0
 def flush():
  if para:out.append(Paragraph(f(' '.join(para)),body));para.clear()
 while i<len(ls):
  raw=ls[i];s=raw.strip()
  if s.startswith('<!--'):i+=1;continue
  if s.startswith('```'):
   flush()
   if inc:out.append(Preformatted('\n'.join(cb).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;'),code));cb=[];inc=False
   else:inc=True
   i+=1;continue
  if inc:cb.append(raw);i+=1;continue
  if not s:flush();i+=1;continue
  if s.startswith('# '):flush();out.extend([Spacer(1,3*mm),Paragraph(f(s[2:]),title)]);i+=1;continue
  if s.startswith('## '):flush();out.append(Paragraph(f(s[3:]),h1));i+=1;continue
  if s.startswith('|') and i+1<len(ls) and re.match(r'^\s*\|?\s*:?-+',ls[i+1]):
   flush();rows=[s];i+=2
   while i<len(ls) and ls[i].strip().startswith('|'):rows.append(ls[i].strip());i+=1
   data=[[Paragraph(f(x.strip()),cell) for x in row.strip('|').split('|')] for row in rows];n=len(data[0]);widths=[WIDTH/n]*n
   if n==3:widths=[38*mm,27*mm,WIDTH-65*mm]
   t=Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT');t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('TEXTCOLOR',(0,0),(-1,0),colors.white),('VALIGN',(0,0),(-1,-1),'TOP'),('GRID',(0,0),(-1,-1),.4,LINE),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,PALE]),('PADDING',(0,0),(-1,-1),4)]));out.extend([t,Spacer(1,3*mm)]);continue
  if re.match(r'^[-*]\s+',s):flush();out.append(Paragraph('• '+f(re.sub(r'^[-*]\s+','',s)),bullet));i+=1;continue
  m=re.match(r'^(\d+)\.\s+(.*)',s)
  if m:flush();out.append(Paragraph(f'<b>{m.group(1)}.</b> {f(m.group(2))}',bullet));i+=1;continue
  para.append(s);i+=1
 flush();return out
OUT.parent.mkdir(parents=True,exist_ok=True);flow=parse();lab=Paragraph('VERSION PUBLICADA',ParagraphStyle('lab',parent=body,fontSize=7,textColor=TEAL,spaceAfter=1));val=Paragraph('5.00.021 | 4 de septiembre de 2026',ParagraphStyle('val',parent=body,fontSize=9,textColor=NAVY,spaceAfter=0));box=Table([[lab,val]],colWidths=[35*mm,WIDTH-35*mm]);box.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),PALE),('BOX',(0,0),(-1,-1),.6,TEAL),('PADDING',(0,0),(-1,-1),6)]));flow[2:2]=[box,Spacer(1,4*mm)];Doc().build(flow)
