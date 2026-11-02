import shutil
import os

db_path = os.path.join(os.environ['TEMP'], 'termany_copy.db')
original_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')

print(f'Copying from: {db_path}')
print(f'To: {original_path}')

try:
    shutil.copy2(db_path, original_path)
    print('[OK] Database updated successfully!')
    
    # Verify the copy
    if os.path.exists(original_path):
        size = os.path.getsize(original_path)
        print(f'[OK] File size: {size} bytes')
except Exception as e:
    print(f'[FAIL] {e}')
