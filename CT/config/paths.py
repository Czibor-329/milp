from __future__ import annotations

import re
from pathlib import Path


_SAFE_PATTERN = re.compile(r"[^a-zA-Z0-9._-]+")
_REPO_ROOT = Path(__file__).resolve().parents[1]
_CONFIG_ROOT = _REPO_ROOT / "config"
_TRAINING_CONFIG_ROOT = _CONFIG_ROOT / "training"
_ROUTES_CONFIG_ROOT = _CONFIG_ROOT / "routes"
_INIT_DATA_CONFIG_ROOT = _CONFIG_ROOT / "init_data"
_UPDATE_DATA_CONFIG_ROOT = _CONFIG_ROOT / "update_data"
_TASK_CONFIG_ROOT = _CONFIG_ROOT / "task"
RESULTS_ROOT = _REPO_ROOT.parent / "results"
ACTION_SEQUENCES_DIR = RESULTS_ROOT / "action_sequences"
TRAINING_LOGS_DIR = RESULTS_ROOT / "training_logs"
MODELS_DIR = RESULTS_ROOT / "models"
OUTPUT_DIR = RESULTS_ROOT / "output"
LOGS_DIR = RESULTS_ROOT / "logs"
PREPROCESSED_DIR = RESULTS_ROOT / "preprocessed"

# MILP 数据集（仓库根/dataset）：train=随机(gen_train.py)，test/<类>=分类网格(gen_test.py)。
DATASET_ROOT = _REPO_ROOT.parent / "dataset"
TRAIN_DIR = DATASET_ROOT / "train"
TEST_ROOT = DATASET_ROOT / "test"
TRAIN_ARTIFACTS_DIR = DATASET_ROOT / "train_artifacts"


def test_set_dir(name: str) -> Path:
    """分类测试集某一类目录，如 test_set_dir("single_stage")。"""
    return TEST_ROOT / name


def ensure_results_dirs() -> None:
    for path in (
        ACTION_SEQUENCES_DIR,
        TRAINING_LOGS_DIR,
        MODELS_DIR,
        OUTPUT_DIR,
        LOGS_DIR,
        PREPROCESSED_DIR,
    ):
        path.mkdir(parents=True, exist_ok=True)


def safe_name(raw: str, default: str) -> str:
    cleaned = _SAFE_PATTERN.sub("_", str(raw).strip())
    return cleaned or default


def model_output_path(filename: str) -> Path:
    ensure_results_dirs()
    return MODELS_DIR / safe_name(filename, "model.pt")

def output_path(filename: str) -> Path:
    ensure_results_dirs()
    return OUTPUT_DIR / safe_name(filename, "output.json")

def preprocessed_path(filename: str) -> Path:
    ensure_results_dirs()
    return PREPROCESSED_DIR / safe_name(filename, "preprocessed.json")

def log_path(filename: str) -> Path:
    ensure_results_dirs()
    return LOGS_DIR / safe_name(filename, "scheduler.log")

def training_config_path(filename: str) -> Path:
    return _TRAINING_CONFIG_ROOT / filename

def input_data_path(filename: str) -> Path:
    name = filename if filename.endswith(".json") else f"{filename}.json"
    return _CONFIG_ROOT / "input_data" / name