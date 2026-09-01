import re
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle,getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate,Frame,PageTemplate,Paragraph,Preformatted,Spacer,Table,TableStyle
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'output'/'pdf';LOGO=ROOT/'static'/'logo-asisto-transparent.png';W=A4[0]-34*mm
NAVY=colors.HexColor('#06264A');TEAL=colors.HexColor('#00C7A5');PALE=colors.HexColor('#EAF4F6');INK=colors.HexColor('#102235');MUTED=colors.HexColor('#52677A');LINE=colors.HexColor('#C9D9E2')
def fmt(s):
 s=s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;');s=re.sub(r'`([^`]+)`',r'<font name="Courier">\1</font>',s);s=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',s);return re.sub(r'\[([^]]+)\]\(([^)]+)\)',r'<link href="\2" color="#007E75">\1</link>',s)
b=getSampleStyleSheet();TITLE=ParagraphStyle('T',parent=b['Title'],fontName='Helvetica-Bold',fontSize=21,leading=25,textColor=NAVY,spaceAfter=11);H1=ParagraphStyle('H1',parent=b['Heading1'],fontName='Helvetica-Bold',fontSize=14,leading=18,textColor=NAVY,spaceBefore=9,spaceAfter=5);BODY=ParagraphStyle('B',parent=b['BodyText'],fontSize=9,leading=12.8,textColor=INK,spaceAfter=5);BUL=ParagraphStyle('L',parent=BODY,leftIndent=12,firstLineIndent=-7);CODE=ParagraphStyle('C',fontName='Courier',fontSize=6.8,leading=9,textColor=INK,backColor=colors.HexColor('#F4F7F9'),borderColor=LINE,borderWidth=.5,borderPadding=7,spaceAfter=7);CELL=ParagraphStyle('cell',parent=BODY,fontSize=7.2,leading=9.2,spaceAfter=0)
class Doc(BaseDocTemplate):
 def __init__(self,p,t):
  super().__init__(p,pagesize=A4,leftMargin=17*mm,rightMargin=17*mm,topMargin=30*mm,bottomMargin=18*mm,title=t,author='Asisto');f=Frame(self.leftMargin,self.bottomMargin,self.width,self.height,id='f',leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0);self.addPageTemplates(PageTemplate(id='p',frames=[f],onPage=self.head))
 def head(self,c,d):
  w,h=A4;c.saveState();c.setFillColor(NAVY);c.rect(0,h-24*mm,w,24*mm,fill=1,stroke=0)
  if LOGO.exists():c.drawImage(str(LOGO),16*mm,h-19*mm,width=25*mm,height=14*mm,preserveAspectRatio=True,anchor='w',mask='auto')
  c.setFillColor(colors.white);c.setFont('Helvetica-Bold',11);c.drawString(47*mm,h-11*mm,'ASISTO | DOCUMENTACION DE API');c.setFont('Helvetica',8);c.drawString(47*mm,h-16*mm,'Version 5.00.011');c.setStrokeColor(TEAL);c.setLineWidth(1.4);c.line(16*mm,h-25.5*mm,w-16*mm,h-25.5*mm);c.setStrokeColor(LINE);c.setLineWidth(.5);c.line(17*mm,13*mm,w-17*mm,13*mm);c.setFillColor(MUTED);c.setFont('Helvetica',7.5);c.drawString(17*mm,8.5*mm,'Asisto | Uso tecnico y de integracion');c.drawRightString(w-17*mm,8.5*mm,f'Pagina {d.page}');c.restoreState()
def story(path):
 ls=path.read_text(encoding='utf-8').splitlines();out=[];para=[];code=[];inc=False;i=0
 def flush():
  if para:out.append(Paragraph(fmt(' '.join(para)),BODY));para.clear()
 while i<len(ls):
  s=ls[i].strip();raw=ls[i]
  if s.startswith('<!--'):i+=1;continue
  if s.startswith('```'):
   flush()
   if inc:out.append(Preformatted('\n'.join(code).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;'),CODE));code=[];inc=False
   else:inc=True
   i+=1;continue
  if inc:code.append(raw);i+=1;continue
  if not s:flush();i+=1;continue
  if s.startswith('# '):flush();out.extend([Spacer(1,3*mm),Paragraph(fmt(s[2:]),TITLE)]);i+=1;continue
  if s.startswith('## '):flush();out.append(Paragraph(fmt(s[3:]),H1));i+=1;continue
  if s.startswith('|') and i+1<len(ls) and re.match(r'^\s*\|?\s*:?-+',ls[i+1]):
   flush();rows=[s];i+=2
   while i<len(ls) and ls[i].strip().startswith('|'):rows.append(ls[i].strip());i+=1
   data=[[Paragraph(fmt(x.strip()),CELL) for x in r.strip('|').split('|')] for r in rows];n=len(data[0]);widths=[W/n]*n
   if n==3:widths=[34*mm,25*mm,W-59*mm]
   t=Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT');t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('TEXTCOLOR',(0,0),(-1,0),colors.white),('VALIGN',(0,0),(-1,-1),'TOP'),('GRID',(0,0),(-1,-1),.4,LINE),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,PALE]),('PADDING',(0,0),(-1,-1),4)]));out.extend([t,Spacer(1,3*mm)]);continue
  if re.match(r'^[-*]\s+',s):flush();out.append(Paragraph('• '+fmt(re.sub(r'^[-*]\s+','',s)),BUL));i+=1;continue
  m=re.match(r'^(\d+)\.\s+(.*)',s)
  if m:flush();out.append(Paragraph(f'<b>{m.group(1)}.</b> {fmt(m.group(2))}',BUL));i+=1;continue
  para.append(s);i+=1
 flush();return out
def build(src,name,title):
 OUT.mkdir(parents=True,exist_ok=True);flow=story(ROOT/src);lab=Paragraph('VERSION PUBLICADA',ParagraphStyle('lab',parent=BODY,fontSize=7,textColor=TEAL,spaceAfter=1));val=Paragraph('5.00.011 | 1 de septiembre de 2026',ParagraphStyle('val',parent=BODY,fontSize=9,textColor=NAVY,spaceAfter=0));box=Table([[lab,val]],colWidths=[35*mm,W-35*mm]);box.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),PALE),('BOX',(0,0),(-1,-1),.6,TEAL),('PADDING',(0,0),(-1,-1),6)]));flow[2:2]=[box,Spacer(1,4*mm)];Doc(str(OUT/name),title).build(flow)
build('docs/api/MANUAL_API_AYUDA.md','Manual_API_Ayuda_Asisto_v5.00.011.pdf','Manual de integracion - API de Ayuda')
build('docs/api/MANUAL_API_AYUDA_SIN_CONSULTA.md','Manual_API_Ayuda_Sin_Consulta_v5.00.011.pdf','API de Ayuda contextual - sin consulta inteligente')
