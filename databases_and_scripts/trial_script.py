import pandas as pd
d = "extracted_csv_20261004/"
pdx = pd.read_csv(d + "project_details.csv", dtype=str)
for c, lo, hi in [("Latitude", -90, 90), ("Longitude", -180, 180)]:
    v = pd.to_numeric(pdx[c], errors="coerce")
    print(pdx.loc[(v < lo) | (v > hi), ["Project ID", "State", "ULB", "Latitude", "Longitude"]])
tn = pd.read_csv(d + "tenders.csv", dtype=str)
v = pd.to_numeric(tn["Financial Progress (in %)"], errors="coerce")
print(tn.loc[(v < 0) | (v > 100), ["Project ID", "Tender ID", "Financial Progress (in %)"]].head(20))