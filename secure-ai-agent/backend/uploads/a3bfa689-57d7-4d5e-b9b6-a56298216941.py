import tkinter as tk
from tkinter import ttk, messagebox
import sqlite3

# Database setup (SQLite)
conn = sqlite3.connect('patient_health.db')
c = conn.cursor()
c.execute('''
    CREATE TABLE IF NOT EXISTS vitals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        blood_pressure TEXT,
        heart_rate INTEGER,
        weight REAL,
        notes TEXT
    )
''')
conn.commit()

# Application GUI
class HealthTrackerApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Patient Health Tracker")
        self.geometry("400x300")

        # Widgets
        ttk.Label(self, text="Date (YYYY-MM-DD):").grid(row=0, column=0, padx=10, pady=5, sticky="w")
        self.date_entry = ttk.Entry(self)
        self.date_entry.grid(row=0, column=1, padx=10, pady=5)

        ttk.Label(self, text="Blood Pressure:").grid(row=1, column=0, padx=10, pady=5, sticky="w")
        self.bp_entry = ttk.Entry(self)
        self.bp_entry.grid(row=1, column=1, padx=10, pady=5)

        ttk.Label(self, text="Heart Rate:").grid(row=2, column=0, padx=10, pady=5, sticky="w")
        self.hr_entry = ttk.Entry(self)
        self.hr_entry.grid(row=2, column=1, padx=10, pady=5)

        ttk.Label(self, text="Weight (kg):").grid(row=3, column=0, padx=10, pady=5, sticky="w")
        self.wt_entry = ttk.Entry(self)
        self.wt_entry.grid(row=3, column=1, padx=10, pady=5)

        ttk.Label(self, text="Notes:").grid(row=4, column=0, padx=10, pady=5, sticky="w")
        self.notes_entry = ttk.Entry(self)
        self.notes_entry.grid(row=4, column=1, padx=10, pady=5)

        ttk.Button(self, text="Save Entry", command=self.save_entry).grid(row=5, column=0, columnspan=2, pady=15)

    def save_entry(self):
        date = self.date_entry.get()
        bp = self.bp_entry.get()
        hr = self.hr_entry.get()
        wt = self.wt_entry.get()
        notes = self.notes_entry.get()

        if not date or not bp or not hr:
            messagebox.showwarning("Input error", "Please fill in Date, BP and Heart Rate.")
            return

        c.execute('INSERT INTO vitals (date, blood_pressure, heart_rate, weight, notes) VALUES (?, ?, ?, ?, ?)',
                  (date, bp, int(hr), float(wt) if wt else None, notes))
        conn.commit()
        messagebox.showinfo("Success", "Entry saved!")
        self.clear_fields()

    def clear_fields(self):
        self.date_entry.delete(0, tk.END)
        self.bp_entry.delete(0, tk.END)
        self.hr_entry.delete(0, tk.END)
        self.wt_entry.delete(0, tk.END)
        self.notes_entry.delete(0, tk.END)

if __name__ == "__main__":
    app = HealthTrackerApp()
    app.mainloop()
