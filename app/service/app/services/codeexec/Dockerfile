# Sandbox image for the codeexec pipeline.
#
# It runs untrusted user analysis code with NO network, a read-only root
# filesystem, pid/memory/cpu limits, and only the user's data (read-only) and
# output dir (read-write) bind-mounted in — see sandbox.py for the `docker run`
# flags. This image just provides the Python interpreter + the analysis libs the
# generated code typically uses.
#
# Build (from app/service/):
#   docker build -t tissuelab-codeexec -f app/services/codeexec/Dockerfile .
#
# Override the image name with CODEEXEC_DOCKER_IMAGE if you tag it differently.

FROM python:3.11-slim

# OpenCV needs libGL/glib even in headless mode.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
        numpy scipy pandas \
        zarr numcodecs \
        scikit-image shapely \
        pillow opencv-python-headless \
        matplotlib

# torch is intentionally left out (large). Add it here if your analyses need it.

WORKDIR /work
# No ENTRYPOINT: sandbox.py runs `python /work/runner.py <code> <zarr> <result>`
# and passes `--user <uid>:<gid>` so outputs are owned by the service account.
