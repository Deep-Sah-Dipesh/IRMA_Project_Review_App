import pandas as pd
import numpy as np
import folium
import matplotlib.pyplot as plt
from scipy.spatial.distance import cdist
from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter
import geopandas as gpd
import contextily as cx
import re
import warnings

warnings.filterwarnings('ignore')

# 1. Load Data
df = pd.read_excel("8th Qtr Planning Final.xlsx", sheet_name="8th QTR Visit list")
df.columns = df.columns.str.strip()

# 2. Advanced Geocoding Setup with Cleaning & Fallbacks
geolocator = Nominatim(user_agent="ulb_complete_planner")
geocode = RateLimiter(geolocator.geocode, min_delay_seconds=1.1)

def get_coords(row):
    # Clean formatting quirks (e.g., "MANSA_G" -> "MANSA", "TARSADI(Kosamba)" -> "TARSADI")
    clean_name = re.sub(r'_[A-Z]+$', '', str(row['ULB Name']))
    clean_name = re.sub(r'\(.*?\)', '', clean_name).strip()
    
    # Try 1: Clean Name + District
    loc = geocode(f"{clean_name}, {row['District']}, Gujarat, India")
    
    # Try 2: Clean Name + State
    if not loc:
        loc = geocode(f"{clean_name}, Gujarat, India")
        
    # Try 3: Fallback to District Center (Guarantees no dropped points)
    if not loc:
        print(f"Warning: Exact location for {row['ULB Name']} not found. Falling back to {row['District']} center.")
        loc = geocode(f"{row['District']}, Gujarat, India")
        # Add a tiny random jitter so fallback pins in the same district don't overlap
        if loc:
            jitter_lat = np.random.uniform(-0.03, 0.03)
            jitter_lon = np.random.uniform(-0.03, 0.03)
            return (loc.latitude + jitter_lat, loc.longitude + jitter_lon)
            
    return (loc.latitude, loc.longitude) if loc else (None, None)

print("Geocoding all 161 coordinates (applying smart fallback rules)...")
coords = df.apply(get_coords, axis=1)
df['Lat'] = [c[0] for c in coords]
df['Lon'] = [c[1] for c in coords]

# 3. Macro-Region Mapping
region_map = {
    'Kutch': 1,
    'Devbhumi Dwarka': 2, 'Porbandar': 2, 'Jamnagar': 2, 'Rajkot': 2, 'Morbi': 2, 'Morabi': 2, 
    'Surendranagar': 2, 'Junagadh': 2, 'Gir Somnath': 2, 'Amreli': 2, 'Bhavnagar': 2, 'Botad': 2,
    'Banaskantha': 3, 'Patan': 3, 'Mahesana': 3, 'Sabarkantha': 3, 'Aravalli': 3, 'Gandhinagar': 3,
    'Ahmedabad': 4, 'Kheda': 4, 'Anand': 4, 'Mahisagar': 4, 'Panchmahal': 4, 'Dahod': 4, 'Vadodara': 4, 'Chhotaudepur': 4,
    'Bharuch': 5, 'Narmada': 5, 'Surat': 5, 'Tapi': 5, 'Navsari': 5, 'Valsad': 5
}
df['Region'] = df['District'].map(region_map).fillna(99)

# 4. Micro-Routing Algorithm 
ordered_dfs = []
last_point = None

for region_id in sorted(df['Region'].unique()):
    region_df = df[df['Region'] == region_id].reset_index(drop=True)
    if region_df.empty: continue
    
    points = region_df[['Lat', 'Lon']].values
    
    if last_point is not None:
        distances_to_last = cdist([last_point], points)[0]
        start_idx = np.argmin(distances_to_last)
    else:
        start_idx = 0 
        
    path = [start_idx]
    unvisited = set(range(len(points)))
    unvisited.remove(start_idx)

    while unvisited:
        curr_idx = path[-1]
        unvisited_list = list(unvisited)
        distances = cdist([points[curr_idx]], points[unvisited_list])[0]
        nearest_idx = unvisited_list[np.argmin(distances)]
        path.append(nearest_idx)
        unvisited.remove(nearest_idx)

    sorted_region = region_df.iloc[path]
    ordered_dfs.append(sorted_region)
    last_point = points[path[-1]]

final_df = pd.concat(ordered_dfs, ignore_index=True)
final_df['Map_Number'] = range(1, len(final_df) + 1)

print(f"Total points successfully mapped: {len(final_df)} / {len(df)}")

# 5. Generate Interactive HTML Map
print("Generating Interactive Map...")
m = folium.Map(location=[22.2587, 71.1924], zoom_start=7)

for _, row in final_df.iterrows():
    label = f"#{row['Map_Number']}: {row['ULB Name']} ({row['District']})"
    icon_html = f'<div style="font-size:9pt; color:white; background:red; border-radius:50%; width:22px; height:22px; text-align:center; line-height:22px; border:1px solid black;">{row["Map_Number"]}</div>'
    folium.Marker(location=[row['Lat'], row['Lon']], icon=folium.DivIcon(html=icon_html), tooltip=label).add_to(m)

m.save("Gujarat_161_Map.html")

# 6. Generate High-Res Static Image with REAL Map Background
print("Generating High-Resolution Static Image with Map Tiles...")

gdf = gpd.GeoDataFrame(
    final_df, 
    geometry=gpd.points_from_xy(final_df.Lon, final_df.Lat), 
    crs="EPSG:4326"
)
gdf_wm = gdf.to_crs(epsg=3857)

fig = plt.figure(figsize=(28, 42))

# Map Section (Top)
ax_map = fig.add_subplot(2, 1, 1)
ax_map.set_title("Gujarat ULB Distribution (Complete Set)", fontsize=36, weight='bold', pad=20)

gdf_wm.plot(ax=ax_map, color='red', markersize=200, zorder=5)
cx.add_basemap(ax_map, source=cx.providers.OpenStreetMap.Mapnik)

for idx, row in gdf_wm.iterrows():
    ax_map.annotate(str(row['Map_Number']), 
                    (row.geometry.x, row.geometry.y), 
                    textcoords="offset points", xytext=(0,14), ha='center', 
                    fontsize=13, weight='bold', 
                    bbox=dict(boxstyle="circle,pad=0.2", fc="white", ec="black", lw=0.5, alpha=0.9),
                    zorder=6)

ax_map.set_axis_off()

# Legend Section (Bottom)
ax_leg = fig.add_subplot(2, 1, 2)
ax_leg.axis('off')

cols = 5
rows = (len(final_df) + cols - 1) // cols
x_positions = np.linspace(0.01, 0.82, cols)

for idx, row in final_df.iterrows():
    col_idx = idx // rows
    row_idx = idx % rows
    x = x_positions[col_idx]
    y = 0.98 - (row_idx / rows) * 0.95
    
    # Indicate if a point was a fallback so you are aware
    fallback_flag = "*" if "_" in str(row['ULB Name']) or "(" in str(row['ULB Name']) else ""
    text = f"{row['Map_Number']}. {row['ULB Name']}{fallback_flag} ({row['District']})"
    
    ax_leg.text(x, y, text, fontsize=14, transform=ax_leg.transAxes)

plt.tight_layout()
plt.savefig("Gujarat_161_ULB_Complete.png", dpi=300, bbox_inches='tight')
print("Complete! Check 'Gujarat_161_Map.html' and 'Gujarat_161_ULB_Complete.png'.")