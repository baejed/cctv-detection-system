import time
import torch
import numpy as np
from ultralytics import YOLO                                       

model = YOLO("eyegila_v4.pt")                                      
dummy = np.zeros((480, 854, 3), dtype=np.uint8)           
                                                                    
for n in [1, 4, 8, 12, 16, 24, 32]:                                
    batch = [dummy] * n                                            
    # warmup                                                       
    model(batch, verbose=False)                           
    start = time.perf_counter()
    for _ in range(20):
        model(batch, verbose=False)
    ms = (time.perf_counter() - start) / 20 * 1000
    print(f"batch={n:2d}  total={ms:.0f}ms  per_cam={ms/n:.1f}ms")