# **Storage Format Migration (HDF5 → Zarr)**

We have updated TissueLab’s internal data storage format from **HDF5 (`.h5`) to Zarr** to support faster loading, streaming, and distributed processing.


Old `.h5` containers are no longer used by the system.  
New data will be automatically saved in the **Zarr-based data container**.

If you encounter missing-data errors or blank inputs in task nodes, simply **delete the original data container and re-run the corresponding segmentation or preprocessing step**.

Thank you for your understanding, this migration significantly improves performance and stability across all workflows.
