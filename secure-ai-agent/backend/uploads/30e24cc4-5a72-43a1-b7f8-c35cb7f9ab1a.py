import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText
import os
import math

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# ---------- Utility functions ----------
def read_text_file(path):
    _, ext = os.path.splitext(path.lower())
    if ext in ['.txt', '.py', '.md', '.csv']:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    # Optional: Add PDF/DOCX support if user installs extra libs
    # For PDF: pip install PyPDF2
    # from PyPDF2 import PdfReader
    # if ext == '.pdf':
    #     reader = PdfReader(path)
    #     return "\n".join(page.extract_text() or "" for page in reader.pages)
    # For DOCX: pip install python-docx
    # from docx import Document
    # if ext == '.docx':
    #     doc = Document(path)
    #     return "\n".join(p.text for p in doc.paragraphs)
    raise ValueError("Unsupported file type: " + ext)

def compute_tfidf_cosine(text1, text2):
    vect = TfidfVectorizer(stop_words='english')
    tfidf = vect.fit_transform([text1, text2])
    sim = cosine_similarity(tfidf[0:1], tfidf[1:2])[0][0]
    return sim

def tokenize_simple(text):
    # Lowercase, split on whitespace and punctuation roughly
    import re
    tokens = re.findall(r'\b\w+\b', text.lower())
    return set(tokens)

def jaccard_similarity(text1, text2):
    s1 = tokenize_simple(text1)
    s2 = tokenize_simple(text2)
    if not s1 and not s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    inter = len(s1 & s2)
    union = len(s1 | s2)
    return inter / union if union != 0 else 0.0

def most_similar_sentence_pair(text1, text2, top_k=1):
    # Split roughly by punctuation into sentences
    import re
    sents1 = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text1) if s.strip()]
    sents2 = [s.strip() for s in re.split(r'(?<=[.!?])\s+', text2) if s.strip()]
    if not sents1 or not sents2:
        return []

    # vectorize all sentences and compute cross-cosine
    vect = TfidfVectorizer(stop_words='english')
    all_sents = sents1 + sents2
    tfidf = vect.fit_transform(all_sents)
    n1 = len(sents1)
    mat1 = tfidf[0:n1]
    mat2 = tfidf[n1:]
    sim_matrix = cosine_similarity(mat1, mat2)

    pairs = []
    for i in range(sim_matrix.shape[0]):
        for j in range(sim_matrix.shape[1]):
            pairs.append((sim_matrix[i,j], sents1[i], sents2[j]))
    pairs.sort(key=lambda x: x[0], reverse=True)
    return pairs[:top_k]

# ---------- GUI ----------
class DocSimApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Document Similarity Checker")
        self.geometry("950x650")
        self._create_widgets()

    def _create_widgets(self):
        # Frames
        top_frame = ttk.Frame(self)
        top_frame.pack(fill='x', padx=8, pady=6)

        btn_load1 = ttk.Button(top_frame, text="Load Document 1", command=self.load_doc1)
        btn_load1.grid(row=0, column=0, padx=4)
        self.lbl_file1 = ttk.Label(top_frame, text="(no file)", width=50)
        self.lbl_file1.grid(row=0, column=1, sticky='w')

        btn_load2 = ttk.Button(top_frame, text="Load Document 2", command=self.load_doc2)
        btn_load2.grid(row=0, column=2, padx=4)
        self.lbl_file2 = ttk.Label(top_frame, text="(no file)", width=50)
        self.lbl_file2.grid(row=0, column=3, sticky='w')

        # Text areas
        text_frame = ttk.Frame(self)
        text_frame.pack(fill='both', expand=True, padx=8, pady=6)

        left = ttk.LabelFrame(text_frame, text="Document 1 (you can paste or load file)")
        left.pack(side='left', fill='both', expand=True, padx=4, pady=4)
        self.txt1 = ScrolledText(left, wrap='word', height=20)
        self.txt1.pack(fill='both', expand=True, padx=4, pady=4)

        right = ttk.LabelFrame(text_frame, text="Document 2 (you can paste or load file)")
        right.pack(side='left', fill='both', expand=True, padx=4, pady=4)
        self.txt2 = ScrolledText(right, wrap='word', height=20)
        self.txt2.pack(fill='both', expand=True, padx=4, pady=4)

        # Controls
        control_frame = ttk.Frame(self)
        control_frame.pack(fill='x', padx=8, pady=6)

        btn_compare = ttk.Button(control_frame, text="Compare Documents", command=self.compare_docs)
        btn_compare.grid(row=0, column=0, padx=4)

        btn_clear = ttk.Button(control_frame, text="Clear", command=self.clear_all)
        btn_clear.grid(row=0, column=1, padx=4)

        # Results
        result_frame = ttk.LabelFrame(self, text="Results")
        result_frame.pack(fill='both', expand=False, padx=8, pady=6)

        self.lbl_cosine = ttk.Label(result_frame, text="Cosine similarity (TF-IDF): --")
        self.lbl_cosine.pack(anchor='w', padx=6, pady=2)

        self.lbl_jaccard = ttk.Label(result_frame, text="Jaccard similarity (token overlap): --")
        self.lbl_jaccard.pack(anchor='w', padx=6, pady=2)

        sep = ttk.Separator(result_frame, orient='horizontal')
        sep.pack(fill='x', padx=6, pady=4)

        self.lbl_top_pair = ttk.Label(result_frame, text="Most similar sentence pair (score shown):")
        self.lbl_top_pair.pack(anchor='w', padx=6, pady=2)

        self.txt_pair = ScrolledText(result_frame, height=6, wrap='word', state='disabled')
        self.txt_pair.pack(fill='x', padx=6, pady=4)

    def load_doc1(self):
        path = filedialog.askopenfilename(title="Select Document 1", filetypes=[("Text & documents", "*.txt *.md *.py *.csv *.pdf *.docx"), ("All files","*.*")])
        if path:
            try:
                text = read_text_file(path)
            except Exception as e:
                messagebox.showerror("Error", f"Could not read file:\n{e}")
                return
            self.txt1.delete('1.0', 'end')
            self.txt1.insert('1.0', text)
            self.lbl_file1.config(text=os.path.basename(path))

    def load_doc2(self):
        path = filedialog.askopenfilename(title="Select Document 2", filetypes=[("Text & documents", "*.txt *.md *.py *.csv *.pdf *.docx"), ("All files","*.*")])
        if path:
            try:
                text = read_text_file(path)
            except Exception as e:
                messagebox.showerror("Error", f"Could not read file:\n{e}")
                return
            self.txt2.delete('1.0', 'end')
            self.txt2.insert('1.0', text)
            self.lbl_file2.config(text=os.path.basename(path))

    def compare_docs(self):
        text1 = self.txt1.get('1.0', 'end').strip()
        text2 = self.txt2.get('1.0', 'end').strip()
        if not text1 or not text2:
            messagebox.showwarning("Input missing", "Please provide both documents (paste or load files).")
            return

        # Compute TF-IDF cosine
        try:
            cos_sim = compute_tfidf_cosine(text1, text2)
        except Exception as e:
            messagebox.showerror("Error computing TF-IDF", str(e))
            return

        # Compute Jaccard
        jacc = jaccard_similarity(text1, text2)

        # Most similar sentence pair
        top_pairs = most_similar_sentence_pair(text1, text2, top_k=1)

        # Update UI
        self.lbl_cosine.config(text=f"Cosine similarity (TF-IDF): {cos_sim:.4f}  ({cos_sim*100:.2f}%)")
        self.lbl_jaccard.config(text=f"Jaccard similarity (token overlap): {jacc:.4f}  ({jacc*100:.2f}%)")

        self.txt_pair.config(state='normal')
        self.txt_pair.delete('1.0', 'end')
        if top_pairs:
            score, s1, s2 = top_pairs[0]
            self.txt_pair.insert('end', f"Score: {score:.4f}  ({score*100:.2f}%)\n\nDocument 1 sentence:\n{s1}\n\nDocument 2 sentence:\n{s2}")
        else:
            self.txt_pair.insert('end', "No sentences to compare or no similarity found.")
        self.txt_pair.config(state='disabled')

    def clear_all(self):
        self.txt1.delete('1.0', 'end')
        self.txt2.delete('1.0', 'end')
        self.lbl_file1.config(text="(no file)")
        self.lbl_file2.config(text="(no file)")
        self.lbl_cosine.config(text="Cosine similarity (TF-IDF): --")
        self.lbl_jaccard.config(text="Jaccard similarity (token overlap): --")
        self.txt_pair.config(state='normal')
        self.txt_pair.delete('1.0', 'end')
        self.txt_pair.config(state='disabled')


if __name__ == "__main__":
    app = DocSimApp()
    app.mainloop()