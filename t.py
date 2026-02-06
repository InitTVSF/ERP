from datetime import date

# 1. Setup Dates
today_date = date.today()
start_date = date(2026, 1, 5)

# 2. Calculate Difference
difference = today_date - start_date

# 3. Calculate Weeks correctly
# We extract the '.days' property first, then do integer division
total_weeks = difference.days // 7

# 4. Initial Weekly Schedule
# (Standardizing names and keeping it clean)
weekly_schedule = {
    'Physics': 2, 
    'Electronics': 2, 
    'Physics Lab': 1, 
    'Elec Lab': 1, 
    'Design': 1,
    'Workshop': 1,
    'Math': 4,
    'C Programming': 3,
    'AI': 1,
    'ML': 1
}

# 5. Calculate Total Attendance to date
# We use a dictionary comprehension for cleaner Pythonic code
total_attendance = {subject: count * total_weeks for subject, count in weekly_schedule.items()}

print(total_attendance.values())