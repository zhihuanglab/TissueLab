from __future__ import annotations

from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA


def fit_pca_basis(
    values: np.ndarray,
    *,
    n_components: int = 1,
    random_state: int = 0,
) -> dict[str, np.ndarray]:
    matrix = np.asarray(values, dtype=float)
    pca = PCA(n_components=n_components, random_state=random_state)
    pca.fit(matrix)
    return {
        "mean": pca.mean_.astype(np.float32),
        "components": pca.components_.astype(np.float32),
        "explained_variance": pca.explained_variance_.astype(np.float32),
        "explained_variance_ratio": pca.explained_variance_ratio_.astype(np.float32),
    }


def save_pca_basis(path: str | Path, basis: dict[str, np.ndarray]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        path,
        mean=np.asarray(basis["mean"], dtype=np.float32),
        components=np.asarray(basis["components"], dtype=np.float32),
        explained_variance=np.asarray(basis.get("explained_variance", []), dtype=np.float32),
        explained_variance_ratio=np.asarray(
            basis.get("explained_variance_ratio", []),
            dtype=np.float32,
        ),
    )
    return path


def load_pca_basis(path: str | Path) -> dict[str, np.ndarray]:
    with np.load(Path(path)) as data:
        return {key: data[key] for key in data.files}


def apply_pca_basis(values: np.ndarray, basis: dict[str, np.ndarray], *, component: int = 0) -> np.ndarray:
    matrix = np.asarray(values, dtype=float)
    centered = matrix - np.asarray(basis["mean"], dtype=float)
    components = np.asarray(basis["components"], dtype=float)
    return centered @ components[component]
