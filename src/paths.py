from __future__ import annotations

import re
from pathlib import Path


_SAFE_PATTERN = re.compile(r"[^a-zA-Z0-9._-]+")
_REPO_ROOT = Path(__file__).resolve().parents[1]   # src 的父 = 仓库根
_CONFIG_ROOT = Path(__file__).resolve().parent     # src/（录制日志随源码迁此）
RESULTS_ROOT = _REPO_ROOT / "results"
ACTION_SEQUENCES_DIR = RESULTS_ROOT / "action_sequences"
TRAINING_LOGS_DIR = RESULTS_ROOT / "training_logs"
MODELS_DIR = RESULTS_ROOT / "models"
OUTPUT_DIR = RESULTS_ROOT / "output"
LOGS_DIR = RESULTS_ROOT / "logs"

# MILP 数据集（仓库根/dataset）：train=随机(gen_train.py)，test/<类>=分类网格(gen_test.py)。
DATASET_ROOT = _REPO_ROOT / "dataset"
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


def log_path(filename: str) -> Path:
    ensure_results_dirs()
    return LOGS_DIR / safe_name(filename, "scheduler.log")


def input_data_path(filename: str) -> Path:
    name = filename if filename.endswith(".json") else f"{filename}.json"
    return _CONFIG_ROOT / "input_data" / name
