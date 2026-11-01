"""Esegue un altro collaudo con longpath.install() attivo (come nell'app): python tests/con_longpath.py tests/test_x.py [arg...]"""
import os
import runpy
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mbvisual import longpath  # noqa: E402

longpath.install()
script = sys.argv[1]
sys.argv = sys.argv[1:]
runpy.run_path(script, run_name="__main__")
