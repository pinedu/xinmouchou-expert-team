#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
薪莫愁·项目用工大数据综合分析报告 Word 文档生成器
严格遵循 Word 规范要求：
  - 一级标题（文档大标题）：宋体 二号（22pt） 黑色 加粗 居中
  - 二级标题：黑体 三号（16pt） 黑色 加粗
  - 正文段落：仿宋 三号（16pt） 黑色 首行缩进2字符（32pt）
"""

import sys
import os
import re
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def set_font(run, font_name, size_pt, bold=False, color_rgb=(0,0,0)):
    run.font.name = font_name
    run.font.size = Pt(size_pt)
    run.font.bold = bold
    run.font.color.rgb = RGBColor(*color_rgb)
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.get_or_add_rFonts()
    rFonts.set(qn('w:eastAsia'), font_name)
    rFonts.set(qn('w:ascii'), font_name)
    rFonts.set(qn('w:hAnsi'), font_name)

def markdown_to_docx(md_text, output_docx_path):
    # 统一报告展示名称；内部路径及原始输入文件不作修改。
    legacy_name = '\u9ed4\u85aa\u4fdd'
    md_text = md_text.replace(legacy_name, '薪莫愁')
    if legacy_name in os.path.basename(output_docx_path):
        raise ValueError('输出文件名请使用薪莫愁，不要使用旧产品名称。')
    doc = Document()
    
    # 页面边距：上下左右各 1 英寸 (2.54cm)
    sections = doc.sections
    for section in sections:
        section.top_margin = Inches(1.0)
        section.bottom_margin = Inches(1.0)
        section.left_margin = Inches(1.1)
        section.right_margin = Inches(1.1)

    lines = md_text.splitlines()
    in_table = False
    table_rows = []

    def flush_table():
        nonlocal in_table, table_rows
        if not table_rows:
            in_table = False
            return
        
        # 过滤表格对齐行 (包含 ---)
        valid_rows = [r for r in table_rows if not re.match(r'^\s*\|?[\s\-:|]+\|?\s*$', r)]
        if not valid_rows:
            in_table = False
            table_rows = []
            return

        parsed_data = []
        for r in valid_rows:
            cells = [c.strip() for c in r.strip().strip('|').split('|')]
            parsed_data.append(cells)

        max_cols = max(len(row) for row in parsed_data)
        table = doc.add_table(rows=len(parsed_data), cols=max_cols)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.style = 'Table Grid'

        for row_idx, row_data in enumerate(parsed_data):
            for col_idx, cell_value in enumerate(row_data):
                if col_idx < max_cols:
                    cell = table.cell(row_idx, col_idx)
                    cell.text = ''
                    p = cell.paragraphs[0]
                    p.paragraph_format.space_before = Pt(3)
                    p.paragraph_format.space_after = Pt(3)
                    run = p.add_run(cell_value)
                    if row_idx == 0:
                        set_font(run, '黑体', 12, bold=True)
                        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    else:
                        set_font(run, '仿宋', 11, bold=False)

        # 表格下方微间距
        p_after = doc.add_paragraph()
        p_after.paragraph_format.space_before = Pt(6)
        p_after.paragraph_format.space_after = Pt(0)
        
        in_table = False
        table_rows = []

    for line in lines:
        raw = line.strip()
        if not raw:
            if in_table:
                flush_table()
            continue

        # 表格识别
        if '|' in raw and (raw.startswith('|') or raw.endswith('|') or '-|-' in raw):
            in_table = True
            table_rows.append(raw)
            continue
        elif in_table:
            flush_table()

        # 1. 一级标题：宋体 二号 (22pt) 黑色 加粗 居中
        if raw.startswith('# '):
            title_text = raw[2:].strip()
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = Pt(16)
            p.paragraph_format.space_after = Pt(18)
            run = p.add_run(title_text)
            set_font(run, '宋体', 22, bold=True)
            continue

        # 2. 二级标题：黑体 三号 (16pt) 黑色 加粗
        if raw.startswith('## '):
            h2_text = raw[3:].strip()
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(14)
            p.paragraph_format.space_after = Pt(6)
            run = p.add_run(h2_text)
            set_font(run, '黑体', 16, bold=True)
            continue

        # 3. 三级标题：黑体 三号 (16pt) 黑色
        if raw.startswith('### '):
            h3_text = raw[4:].strip()
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(10)
            p.paragraph_format.space_after = Pt(4)
            run = p.add_run(h3_text)
            set_font(run, '黑体', 16, bold=True)
            continue

        # 列表条目（- 或 1.）
        if raw.startswith('- ') or raw.startswith('* ') or re.match(r'^\d+\.\s', raw):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Pt(32)
            p.paragraph_format.line_spacing = 1.3
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            
            clean_text = re.sub(r'^[-*]\s+|\d+\.\s+', '', raw)
            # 处理加粗标识 **xxx**
            parts = re.split(r'(\*\*.*?\*\*)', clean_text)
            bullet_run = p.add_run('• ')
            set_font(bullet_run, '仿宋', 16, bold=True)
            for part in parts:
                if part.startswith('**') and part.endswith('**'):
                    run = p.add_run(part[2:-2])
                    set_font(run, '黑体', 16, bold=True)
                else:
                    run = p.add_run(part)
                    set_font(run, '仿宋', 16, bold=False)
            continue

        # 4. 正文段落：仿宋 三号 (16pt) 黑色 首行缩进2字符 (32pt)
        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Pt(32) # 首行缩进 2 字符 (16pt * 2)
        p.paragraph_format.line_spacing = 1.3
        p.paragraph_format.space_before = Pt(3)
        p.paragraph_format.space_after = Pt(3)
        
        # 处理正文内的加粗标识 **xxx**
        parts = re.split(r'(\*\*.*?\*\*)', raw)
        for part in parts:
            if part.startswith('**') and part.endswith('**'):
                run = p.add_run(part[2:-2])
                set_font(run, '黑体', 16, bold=True)
            else:
                run = p.add_run(part)
                set_font(run, '仿宋', 16, bold=False)

    if in_table:
        flush_table()

    os.makedirs(os.path.dirname(os.path.abspath(output_docx_path)), exist_ok=True)
    doc.save(output_docx_path)
    print(f"Word 文档已生成：{os.path.basename(output_docx_path)}")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("用法: python export-word.py <input.md> <output.docx>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    markdown_to_docx(content, output_file)
