import re

def update_map_pins(input_file, output_file):
    print(f"Reading {input_file}...")
    try:
        with open(input_file, "r", encoding="utf-8") as f:
            content = f.read()
            
        # Target Folium's unicode-escaped HTML structure (\u003c instead of <)
        old_pattern = r'\\u003cdiv style=\\"(?:(?!\\u003e)[\s\S])*?border: 1\.5px solid #d32f2f;(?:(?!\\u003e)[\s\S])*?\\"\\u003e\s*(.*?)\s*\\u003c/div\\u003e'

        def replacer(match):
            short_name = match.group(1).strip()
            
            # FIXED: Swapped external PNG for an inline SVG. 
            # - Edit `width: 16px; height: 16px;` to adjust size.
            # - Edit `fill: #007BFF;` to change the color (e.g., #d32f2f for red, #28a745 for green).
            new_html = f'<div style="display: flex; align-items: center; transform: translate(-50%, -100%);"><svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: #007BFF; flex-shrink: 0;"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><span style="font-size: 8pt; font-family: Arial, sans-serif; font-weight: bold; color: #1a1a1a; margin-left: 2px; white-space: nowrap; text-shadow: 1px 1px 2px rgba(255,255,255,0.9), -1px -1px 2px rgba(255,255,255,0.9), 1px -1px 2px rgba(255,255,255,0.9), -1px 1px 2px rgba(255,255,255,0.9);">{short_name}</span></div>'
            
            # Re-escape the new HTML so Folium's Javascript parser doesn't break
            return new_html.replace('"', '\\"').replace('<', '\\u003c').replace('>', '\\u003e')

        # Perform the global replacement for all 161 markers
        updated_content, replacements = re.subn(old_pattern, replacer, content)

        if replacements == 0:
            print("Warning: No matching red boxes found. Ensure this is the correct unedited HTML file.")
        else:
            with open(output_file, "w", encoding="utf-8") as f:
                f.write(updated_content)
            print(f"Success! {replacements} map markers were updated.")
            print(f"Your new map is saved as: {output_file}")
            
    except FileNotFoundError:
        print(f"Error: {input_file} not found in this directory.")

if __name__ == "__main__":
    # Ensure this matches the exact name of the file you uploaded
    INPUT_HTML = "Gujarat_161_Named_Map.html"  
    OUTPUT_HTML = "Gujarat_All_ULBs_on_Maps_Final_Edit.html"
    update_map_pins(INPUT_HTML, OUTPUT_HTML)