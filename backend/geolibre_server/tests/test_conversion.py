import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

from geolibre_server.app import conversion
from geolibre_server.app.conversion import (
    _CAD_DXF_SCRIPT,
    _PMTILES_SCRIPT,
    _RASTER_SCRIPT,
    _RESULT_MARKER,
    _VECTOR_SCRIPT,
    _VECTOR_TO_VECTOR_SCRIPT,
    _evict_finished_jobs_locked,
    _output_extension,
    _validate_paths,
    _validate_input_path,
    cad_read_dxf,
    cancel_conversion_job,
    csv_to_geoparquet,
    raster_to_cog,
    vector_to_geoparquet,
    vector_to_geopackage,
    vector_to_pmtiles,
    vector_to_shapefile,
    vector_to_vector,
    CsvToGeoParquetRequest,
    RasterToCogRequest,
    VectorToGeoPackageRequest,
    VectorToGeoParquetRequest,
    VectorToPmtilesRequest,
    VectorToShapefileRequest,
    VectorToVectorRequest,
    CadReadDxfRequest,
)
from geolibre_server.app.runtime import JobState


def test_embedded_scripts_compile() -> None:
    """The inline conversion scripts must be valid Python with a result marker."""
    for script in (
        _CAD_DXF_SCRIPT,
        _VECTOR_SCRIPT,
        _VECTOR_TO_VECTOR_SCRIPT,
        _RASTER_SCRIPT,
        _PMTILES_SCRIPT,
    ):
        compile(script, "<script>", "exec")
        assert _RESULT_MARKER in script
        assert "{marker}" not in script


def test_cad_script_sanitizes_properties_and_bounds_geometry() -> None:
    """The native DXF boundary returns geometry-only bounded DTOs."""
    assert '"properties": {}' in _CAD_DXF_SCRIPT
    assert "max_coordinates = 1000000" in _CAD_DXF_SCRIPT
    assert "max_geometry_depth = 32" in _CAD_DXF_SCRIPT
    assert "DXF_COORDINATE_LIMIT" in _CAD_DXF_SCRIPT
    assert "DXF_GEOMETRY_DEPTH" in _CAD_DXF_SCRIPT
    assert "SELECT {geometry} AS geometry" in _CAD_DXF_SCRIPT


def test_validate_cad_input_accepts_only_existing_dxf(tmp_path: Path) -> None:
    source = tmp_path / "site.dxf"
    source.write_text("0\nEOF\n", encoding="utf-8")
    assert _validate_input_path(str(source), {"dxf"}) == str(source)

    wrong = tmp_path / "site.geojson"
    wrong.write_text("{}", encoding="utf-8")
    with pytest.raises(HTTPException) as excinfo:
        _validate_input_path(str(wrong), {"dxf"})
    assert excinfo.value.status_code == 400
    assert "DXF" in excinfo.value.detail


def test_cad_read_dxf_starts_result_only_job(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "site.dxf"
    source.write_text("0\nEOF\n", encoding="utf-8")
    captured = {}

    def fake_start(tool_id, script, params, output_name):
        captured.update(
            tool_id=tool_id,
            script=script,
            params=params,
            output_name=output_name,
        )
        return "job"

    monkeypatch.setattr(conversion, "_start_job", fake_start)
    result = cad_read_dxf(CadReadDxfRequest(input_path=str(source)))

    assert result == "job"
    assert captured == {
        "tool_id": "cad-read-dxf",
        "script": _CAD_DXF_SCRIPT,
        "params": {"input_path": str(source)},
        "output_name": "",
    }


def test_validate_paths_accepts_existing_input_and_folder(tmp_path: Path) -> None:
    """Existing input files and writable output folders pass validation."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    input_path, output_path = _validate_paths(
        str(source), str(tmp_path / "out.parquet")
    )
    assert input_path == str(source)
    assert output_path == str(tmp_path / "out.parquet")


def test_validate_paths_rejects_missing_input(tmp_path: Path) -> None:
    """A missing input file is reported as a 400 error."""
    with pytest.raises(HTTPException) as excinfo:
        _validate_paths(str(tmp_path / "missing.tif"), str(tmp_path / "out.tif"))
    assert excinfo.value.status_code == 400


def test_validate_paths_rejects_missing_output_folder(tmp_path: Path) -> None:
    """An output folder that does not exist is reported as a 400 error."""
    source = tmp_path / "input.tif"
    source.write_bytes(b"")
    with pytest.raises(HTTPException) as excinfo:
        _validate_paths(str(source), str(tmp_path / "nope" / "out.tif"))
    assert excinfo.value.status_code == 400


def test_validate_paths_rejects_outside_allowed_roots(
    tmp_path: Path, monkeypatch
) -> None:
    """With an allowlist set, paths outside the roots are rejected (403)."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.geojson"
    outside.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(allowed.resolve())])
    with pytest.raises(HTTPException) as excinfo:
        _validate_paths(str(outside), str(allowed / "out.parquet"))
    assert excinfo.value.status_code == 403


def test_validate_paths_rejects_output_outside_allowed_roots(
    tmp_path: Path, monkeypatch
) -> None:
    """An allowlisted input but out-of-root output is rejected (403)."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    source = allowed / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(allowed.resolve())])
    with pytest.raises(HTTPException) as excinfo:
        _validate_paths(str(source), str(outside_dir / "out.parquet"))
    assert excinfo.value.status_code == 403


def test_validate_paths_allows_within_allowed_roots(
    tmp_path: Path, monkeypatch
) -> None:
    """Paths under an allowlisted root pass validation."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    source = allowed / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(conversion, "_CONVERSION_ROOTS", [str(allowed.resolve())])
    input_path, output_path = _validate_paths(
        str(source), str(allowed / "out.parquet")
    )
    assert input_path == str(source.resolve())
    assert output_path == str((allowed / "out.parquet").resolve())


def test_runtime_python_caches_after_first_call(monkeypatch) -> None:
    """The import check runs at most once across repeated _runtime_python calls."""
    import_calls = 0

    def fake_check(python_executable: str) -> None:
        nonlocal import_calls
        import_calls += 1

    monkeypatch.setattr(conversion, "_CHECKED_RUNTIME_PYTHON", None)
    monkeypatch.setenv("GEOLIBRE_CONVERSION_PYTHON", sys.executable)
    monkeypatch.setattr(conversion, "_check_runtime_import", fake_check)

    assert conversion._runtime_python() == sys.executable
    conversion._runtime_python()
    assert import_calls == 1


def test_vector_to_geoparquet_rejects_unknown_compression(tmp_path: Path) -> None:
    """Unsupported Parquet compressions are rejected before starting a job."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    request = VectorToGeoParquetRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.parquet"),
        compression="brotli9000",
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_geoparquet(request)
    assert excinfo.value.status_code == 400


def test_vector_to_geoparquet_rejects_nonpositive_row_group_size(
    tmp_path: Path,
) -> None:
    """A non-positive row group size is rejected before starting a job."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    request = VectorToGeoParquetRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.parquet"),
        row_group_size=0,
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_geoparquet(request)
    assert excinfo.value.status_code == 400


def test_raster_to_cog_rejects_unknown_compression(tmp_path: Path) -> None:
    """Unsupported COG compressions are rejected before starting a job."""
    source = tmp_path / "input.tif"
    source.write_bytes(b"")
    request = RasterToCogRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.tif"),
        compression="zip",
    )
    with pytest.raises(HTTPException) as excinfo:
        raster_to_cog(request)
    assert excinfo.value.status_code == 400


def test_csv_to_geoparquet_requires_lon_lat(tmp_path: Path) -> None:
    """Missing lon/lat column names are rejected before starting a job."""
    source = tmp_path / "points.csv"
    source.write_text("name,x,y\n", encoding="utf-8")
    request = CsvToGeoParquetRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.parquet"),
        lon_column=" ",
        lat_column="y",
    )
    with pytest.raises(HTTPException) as excinfo:
        csv_to_geoparquet(request)
    assert excinfo.value.status_code == 400


def test_csv_to_geoparquet_rejects_unknown_compression(tmp_path: Path) -> None:
    """Unsupported Parquet compressions are rejected for CSV conversion too."""
    source = tmp_path / "points.csv"
    source.write_text("name,x,y\n", encoding="utf-8")
    request = CsvToGeoParquetRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.parquet"),
        lon_column="x",
        lat_column="y",
        compression="brotli",
    )
    with pytest.raises(HTTPException) as excinfo:
        csv_to_geoparquet(request)
    assert excinfo.value.status_code == 400


def test_vector_to_pmtiles_rejects_bad_zoom_range(tmp_path: Path) -> None:
    """min_zoom greater than max_zoom is rejected before starting a job."""
    source = tmp_path / "in.parquet"
    source.write_bytes(b"")
    request = VectorToPmtilesRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.pmtiles"),
        min_zoom=10,
        max_zoom=4,
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_pmtiles(request)
    assert excinfo.value.status_code == 400


def test_vector_to_shapefile_rejects_missing_input(tmp_path: Path) -> None:
    """A missing input file is rejected before a Shapefile job starts."""
    request = VectorToShapefileRequest(
        input_path=str(tmp_path / "missing.geojson"),
        output_path=str(tmp_path / "out.zip"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_shapefile(request)
    assert excinfo.value.status_code == 400


def test_vector_to_geopackage_rejects_missing_input(tmp_path: Path) -> None:
    """A missing input file is rejected before a GeoPackage job starts."""
    request = VectorToGeoPackageRequest(
        input_path=str(tmp_path / "missing.geojson"),
        output_path=str(tmp_path / "out.gpkg"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_geopackage(request)
    assert excinfo.value.status_code == 400


def test_output_extension_parsing() -> None:
    """The output extension is parsed case-insensitively, ignoring directories."""
    assert _output_extension("/a/b/cities.GPKG") == "gpkg"
    assert _output_extension("cities.tar.gz") == "gz"
    assert _output_extension("/no/extension/here") == ""


def test_vector_to_vector_rejects_unsupported_extension(tmp_path: Path) -> None:
    """An output extension with no known driver is rejected before a job starts."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    request = VectorToVectorRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out.docx"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_vector(request)
    assert excinfo.value.status_code == 400
    assert "docx" in excinfo.value.detail


def test_vector_to_vector_requires_output_extension(tmp_path: Path) -> None:
    """An output path without an extension cannot select a format."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    request = VectorToVectorRequest(
        input_path=str(source),
        output_path=str(tmp_path / "out"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_vector(request)
    assert excinfo.value.status_code == 400


def test_vector_to_vector_rejects_missing_input(tmp_path: Path) -> None:
    """A missing input file is rejected before a conversion job starts."""
    request = VectorToVectorRequest(
        input_path=str(tmp_path / "missing.geojson"),
        output_path=str(tmp_path / "out.gpkg"),
    )
    with pytest.raises(HTTPException) as excinfo:
        vector_to_vector(request)
    assert excinfo.value.status_code == 400


@pytest.mark.parametrize(
    ("output_name", "expected_kind", "expected_driver", "expected_zip"),
    [
        ("out.gpkg", "gdal", "GPKG", False),
        ("out.fgb", "gdal", "FlatGeobuf", False),
        ("out.geojson", "gdal", "GeoJSON", False),
        ("out.kml", "gdal", "KML", False),
        ("out.shp", "gdal", "ESRI Shapefile", False),
        ("out.zip", "gdal", "ESRI Shapefile", True),
        ("out.csv", "gdal", "CSV", False),
        ("out.parquet", "parquet", "", False),
        ("out.geoparquet", "parquet", "", False),
    ],
)
def test_vector_to_vector_routes_extension_to_driver(
    tmp_path: Path,
    monkeypatch,
    output_name: str,
    expected_kind: str,
    expected_driver: str,
    expected_zip: bool,
) -> None:
    """The output extension is mapped to the right writer params for the job."""
    source = tmp_path / "input.geojson"
    source.write_text("{}", encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_start_job(tool_id, script, params, output_name):  # noqa: ANN001
        captured["tool_id"] = tool_id
        captured["script"] = script
        captured["params"] = params
        return _job("job", "pending", "2026-01-01T00:00:00+00:00")

    monkeypatch.setattr(conversion, "_start_job", fake_start_job)
    request = VectorToVectorRequest(
        input_path=str(source),
        output_path=str(tmp_path / output_name),
    )
    vector_to_vector(request)

    assert captured["tool_id"] == "vector-to-vector"
    assert captured["script"] is _VECTOR_TO_VECTOR_SCRIPT
    params = captured["params"]
    assert params["output_kind"] == expected_kind
    assert params["output_driver"] == expected_driver
    assert params["zip_shapefile"] is expected_zip


def _job(job_id: str, status: str, created_at: str) -> JobState:
    """Build a JobState fixture with a controllable creation timestamp."""
    return JobState(
        id=job_id,
        status=status,
        tool_id="vector-to-geoparquet",
        created_at=created_at,
        updated_at=created_at,
    )


def test_evict_finished_jobs_drops_oldest_first(monkeypatch) -> None:
    """Eviction removes the oldest finished jobs, regardless of insert order."""
    monkeypatch.setattr(conversion, "MAX_RETAINED_JOBS", 2)
    # Insertion order deliberately does not match chronological order.
    jobs = {
        "c": _job("c", "succeeded", "2026-01-03T00:00:00+00:00"),
        "a": _job("a", "succeeded", "2026-01-01T00:00:00+00:00"),
        "b": _job("b", "failed", "2026-01-02T00:00:00+00:00"),
    }
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    _evict_finished_jobs_locked()
    # Only the single oldest finished job (created 01-01) should be evicted.
    assert set(jobs) == {"b", "c"}


def test_evict_finished_jobs_never_drops_running(monkeypatch) -> None:
    """Running and pending jobs are retained even when over the cap."""
    monkeypatch.setattr(conversion, "MAX_RETAINED_JOBS", 1)
    jobs = {
        "old_running": _job("old_running", "running", "2026-01-01T00:00:00+00:00"),
        "pending": _job("pending", "pending", "2026-01-02T00:00:00+00:00"),
        "done": _job("done", "succeeded", "2026-01-03T00:00:00+00:00"),
    }
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    _evict_finished_jobs_locked()
    # Excess is 2, but only the one finished job is eligible for eviction.
    assert set(jobs) == {"old_running", "pending"}


def test_evict_protects_cancelled_job_until_worker_cleanup(monkeypatch) -> None:
    """Cancelled state remains addressable until its worker finalizer completes."""
    monkeypatch.setattr(conversion, "MAX_RETAINED_JOBS", 1)
    jobs = {
        "cancelled": _job(
            "cancelled", "cancelled", "2026-01-01T00:00:00+00:00"
        ),
        "done": _job("done", "succeeded", "2026-01-02T00:00:00+00:00"),
    }
    active_workers = {"cancelled"}
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    monkeypatch.setattr(conversion, "_ACTIVE_WORKERS", active_workers)

    _evict_finished_jobs_locked()

    assert set(jobs) == {"cancelled"}

    active_workers.clear()
    jobs["new"] = _job("new", "succeeded", "2026-01-03T00:00:00+00:00")
    _evict_finished_jobs_locked()
    assert set(jobs) == {"new"}


def test_start_job_returns_snapshot_before_immediate_worker_eviction(monkeypatch) -> None:
    """An immediate completion cannot be evicted before the POST response is built."""
    jobs: dict[str, JobState] = {}
    active_workers: set[str] = set()
    monkeypatch.setattr(conversion, "MAX_RETAINED_JOBS", 0)
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    monkeypatch.setattr(conversion, "_ACTIVE_WORKERS", active_workers)

    def finish_immediately(job_id, _script, _params, _output_name) -> None:
        with conversion._JOBS_LOCK:
            jobs[job_id] = jobs[job_id].model_copy(
                update={"status": "succeeded"}
            )
            active_workers.discard(job_id)
            _evict_finished_jobs_locked()

    class ImmediateThread:
        def __init__(self, *, target, args, daemon) -> None:
            self.target = target
            self.args = args
            self.daemon = daemon

        def start(self) -> None:
            self.target(*self.args)

    monkeypatch.setattr(conversion, "_run_conversion_job", finish_immediately)
    monkeypatch.setattr(conversion.threading, "Thread", ImmediateThread)

    result = conversion._start_job("cad-read-dxf", "", {}, "output")

    assert result.status == "succeeded"
    assert jobs == {}


class _FakeRunningProcess:
    def __init__(self) -> None:
        self.killed = False

    def poll(self):
        return -9 if self.killed else None

    def kill(self) -> None:
        self.killed = True


def test_cancel_conversion_job_kills_running_process(monkeypatch) -> None:
    """Cancellation marks the job terminal and kills its active subprocess."""
    process = _FakeRunningProcess()
    jobs = {"cad": _job("cad", "running", "2026-01-01T00:00:00+00:00")}
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    monkeypatch.setattr(conversion, "_ACTIVE_PROCESSES", {"cad": process})

    cancelled = cancel_conversion_job("cad")

    assert cancelled.status == "cancelled"
    assert jobs["cad"].status == "cancelled"
    assert process.killed is True


def test_cancel_conversion_job_is_idempotent_for_finished_job(monkeypatch) -> None:
    """A late cancel cannot overwrite a completed result."""
    jobs = {"done": _job("done", "succeeded", "2026-01-01T00:00:00+00:00")}
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    monkeypatch.setattr(conversion, "_ACTIVE_PROCESSES", {})

    result = cancel_conversion_job("done")

    assert result.status == "succeeded"


def test_cancelled_job_never_bootstraps_or_spawns(monkeypatch) -> None:
    """A pending job cancelled before worker start must not consume runtime resources."""
    jobs = {"cad": _job("cad", "cancelled", "2026-01-01T00:00:00+00:00")}
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    monkeypatch.setattr(conversion, "_ACTIVE_PROCESSES", {})
    monkeypatch.setattr(
        conversion,
        "_runtime_python",
        lambda: pytest.fail("cancelled job must not bootstrap the runtime"),
    )

    conversion._run_conversion_job("cad", "", {}, "")

    assert jobs["cad"].status == "cancelled"


def test_cancel_running_worker_kills_process_and_removes_partial_output(
    tmp_path: Path, monkeypatch
) -> None:
    """The real worker/process boundary terminates and cleans output on cancel."""
    output_path = tmp_path / "partial.bin"
    jobs = {"job": _job("job", "pending", "2026-01-01T00:00:00+00:00")}
    active_processes = {}
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    monkeypatch.setattr(conversion, "_ACTIVE_PROCESSES", active_processes)
    monkeypatch.setattr(conversion, "_runtime_python", lambda: sys.executable)
    script = (
        "import json,sys,time; "
        "p=json.loads(sys.argv[1]); "
        "open(p['output_path'],'wb').write(b'partial'); "
        "time.sleep(60)"
    )
    worker = threading.Thread(
        target=conversion._run_conversion_job,
        args=("job", script, {"output_path": str(output_path)}, "output"),
    )
    worker.start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if "job" in active_processes and output_path.exists():
            break
        time.sleep(0.01)
    assert "job" in active_processes
    assert output_path.exists()

    cancelled = cancel_conversion_job("job")
    worker.join(timeout=5)

    assert cancelled.status == "cancelled"
    assert worker.is_alive() is False
    assert "job" not in active_processes
    assert output_path.exists() is False


def test_cancel_cleanup_removes_partial_output_when_process_kill_raises(
    tmp_path: Path, monkeypatch
) -> None:
    """A stale Windows process handle cannot skip partial-output cleanup."""
    output_path = tmp_path / "partial.bin"
    jobs = {"job": _job("job", "pending", "2026-01-01T00:00:00+00:00")}
    active_processes = {}
    active_workers = {"job"}
    monkeypatch.setattr(conversion, "_JOBS", jobs)
    monkeypatch.setattr(conversion, "_ACTIVE_PROCESSES", active_processes)
    monkeypatch.setattr(conversion, "_ACTIVE_WORKERS", active_workers)
    monkeypatch.setattr(conversion, "_runtime_python", lambda: sys.executable)

    class CancellingStream:
        def __iter__(self):
            output_path.write_bytes(b"partial")
            with conversion._JOBS_LOCK:
                jobs["job"] = jobs["job"].model_copy(
                    update={"status": "cancelled"}
                )
            return iter(())

    class StaleHandleProcess:
        stdout = CancellingStream()

        def wait(self) -> int:
            return 0

        def poll(self):
            return None

        def kill(self) -> None:
            raise OSError("stale process handle")

    monkeypatch.setattr(
        conversion.subprocess,
        "Popen",
        lambda *args, **kwargs: StaleHandleProcess(),
    )

    conversion._run_conversion_job(
        "job", "", {"output_path": str(output_path)}, "output"
    )

    assert jobs["job"].status == "cancelled"
    assert "job" not in active_processes
    assert "job" not in active_workers
    assert output_path.exists() is False
