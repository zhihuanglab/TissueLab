import numpy as np
from PIL import Image, ImageOps
import cv2
import numpy as np
from skimage.color import rgb2hed
from skimage.filters import threshold_otsu
from skimage import morphology, measure
import h5py
import os

# this is for debug
class PostProcess:
    def __init__(self, img, level, x1, y1, x2, y2, app) -> None:
        self.img = img
        self.img_np = np.array(self.img)
        self.level = level
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2
        self.app = app
        
        self.nuclei_data_loaded = False
        self.centroids = None
        self.contours = None
        self.probability = None
        self.load_nuclei_data()

    def run(self):
        # self.draw_nuclei_contours() # Note: we should not use it in Python. Load h5 file and visualize in JS.
        # self.object_detector()
        pass

    def inverse(self):
        self.img = Image.fromarray(self.img_np)
        self.img = ImageOps.invert(self.img)

    def object_detector(self, method="vanilla"):
        if method == "vanilla":
            # Check if over 90% of pixels are background
            background_pixels = np.sum((self.img_np > 230).all(axis=2))
            total_pixels = self.img_np.shape[0] * self.img_np.shape[1]
            if background_pixels / total_pixels > 0.9:
                # print("Over 90% of pixels are background. Skipping this tile.")
                return Image.fromarray(self.img_np)

            # Step 1: Color Deconvolution
            hed = rgb2hed(self.img_np)
            hematoxylin_channel = hed[:, :, 0]  # Hematoxylin channel
            # Step 2: Enhance Contrast (optional)
            # You can adjust this step based on your image's contrast
            hematoxylin_enhanced = np.clip(hematoxylin_channel * 1.5, 0, 1)
            # Step 3: Thresholding
            thresh_val = threshold_otsu(hematoxylin_enhanced)
            binary_mask = hematoxylin_enhanced > thresh_val
            # Step 4: Morphological Operations
            cleaned_mask = morphology.remove_small_objects(binary_mask, min_size=50)
            cleaned_mask = morphology.closing(cleaned_mask, morphology.disk(3))
            # Step 5: Segmentation
            #labeled_nuclei = measure.label(cleaned_mask)
            # Find contours from the cleaned_mask
            contours, hierarchy = cv2.findContours((cleaned_mask * 255).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            # Draw contours on the original image
            cv2.drawContours(self.img_np, contours, -1, (255, 0, 0), 2)  # Drawing in blue with thickness of 2
            self.img = Image.fromarray(self.img_np)

    def load_nuclei_data(self):
        if not self.nuclei_data_loaded:
            try:
                h5_path = os.path.join("/home/zhihuang/Desktop/TissueLab/example_WSI", 'nuclei_data.h5')
                with h5py.File(h5_path, 'r') as hf:
                    # Safely load datasets
                    centroids_dataset = hf['centroids']
                    contours_dataset = hf['contours']
                    probability_dataset = hf['probability']
                    
                    if centroids_dataset.shape == ():  # scalar dataset
                        self.centroids = centroids_dataset[()]
                    else:  # array dataset
                        self.centroids = centroids_dataset[:]
                        
                    if contours_dataset.shape == ():  # scalar dataset
                        self.contours = contours_dataset[()]
                    else:  # array dataset
                        self.contours = contours_dataset[:]
                        
                    if probability_dataset.shape == ():  # scalar dataset
                        self.probability = probability_dataset[()]
                    else:  # array dataset
                        self.probability = probability_dataset[:]
                self.nuclei_data_loaded = True
            except:
                pass

    def draw_nuclei_contours(self):
        if self.nuclei_data_loaded:
            # Get subset of indices that meet the condition
            valid_indices = np.where(
                (self.centroids[:, 0] >= self.x1) & (self.centroids[:, 0] < self.x2) &
                (self.centroids[:, 1] >= self.y1) & (self.centroids[:, 1] < self.y2)
            )[0]
            print(self.level)
            # Only iterate over the valid indices
            for idx in valid_indices:
                adjusted_contour = self.contours[idx] - [self.x1, self.y1]
                cv2.drawContours(self.img_np, [adjusted_contour.astype(np.int32)], 0, (0, 255, 0), 2)
            
            self.img = Image.fromarray(self.img_np)
