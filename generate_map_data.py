import pandas as pd
import folium
from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter

df = pd.read_excel("8th Qtr Planning Final.xlsx", sheet_name="8th QTR Visit list")
df.columns = df.columns.str.strip()
df_sorted = df.sort_values(by=['District', 'ULB Name']).reset_index(drop=True)
df_sorted['Map_Number'] = range(1, len(df_sorted) + 1)

geolocator = Nominatim(user_agent="ulb_planner")
geocode = RateLimiter(geolocator.geocode, min_delay_seconds=1.1)

def get_coords(row):
    loc = geocode(f"{row['ULB Name']}, {row['District']}, Gujarat, India")
    if not loc:
        loc = geocode(f"{row['ULB Name']}, Gujarat, India")
    return (loc.latitude, loc.longitude) if loc else (None, None)

print("Geocoding... (Takes ~3 mins to respect API limits)")
coords = df_sorted.apply(get_coords, axis=1)
df_sorted['Lat'] = [c[0] for c in coords]
df_sorted['Lon'] = [c[1] for c in coords]

gujarat_map = folium.Map(location=[22.2587, 71.1924], zoom_start=7)

for _, row in df_sorted.dropna(subset=['Lat', 'Lon']).iterrows():
    label = f"#{row['Map_Number']}: {row['ULB Name']} ({row['District']})"
    icon_html = f'<div style="font-size:10pt; color:white; background:red; border-radius:50%; width:24px; height:24px; text-align:center; line-height:24px; border:1px solid black;">{row["Map_Number"]}</div>'
    
    folium.Marker(
        location=[row['Lat'], row['Lon']],
        icon=folium.DivIcon(html=icon_html),
        tooltip=label
    ).add_to(gujarat_map)

gujarat_map.save("Gujarat_ULB_Visit_Map.html")
print("Map successfully generated as 'Gujarat_ULB_Visit_Map.html'. Open this file in your browser.")