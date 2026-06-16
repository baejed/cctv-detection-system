"""Intersection + street CRUD tests."""
import pytest
import requests
from tests.conftest import API_URL


@pytest.fixture
def intersection(auth):
    """Create a temporary intersection and clean it up after the test."""
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_test_intersection", "latitude": 7.4478, "longitude": 125.8057})
    assert r.status_code == 200
    obj = r.json()
    yield obj
    auth.delete(f"{API_URL}/intersections/{obj['id']}")


def test_create_intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_ci_test", "latitude": 7.0, "longitude": 125.0})
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "_ci_test"
    auth.delete(f"{API_URL}/intersections/{data['id']}")


def test_list_intersections(auth, intersection):
    r = auth.get(f"{API_URL}/intersections/")
    assert r.status_code == 200
    ids = [i["id"] for i in r.json()]
    assert intersection["id"] in ids


def test_get_intersection(auth, intersection):
    r = auth.get(f"{API_URL}/intersections/{intersection['id']}")
    assert r.status_code == 200
    assert r.json()["name"] == "_test_intersection"


def test_get_intersection_404(auth):
    r = auth.get(f"{API_URL}/intersections/999999")
    assert r.status_code == 404


def test_update_intersection(auth, intersection):
    r = auth.put(f"{API_URL}/intersections/{intersection['id']}",
                 json={"name": "_test_intersection_renamed"})
    assert r.status_code == 200
    assert r.json()["name"] == "_test_intersection_renamed"


def test_delete_intersection(auth):
    r = auth.post(f"{API_URL}/intersections/",
                  json={"name": "_del_test", "latitude": 0.0, "longitude": 0.0})
    iid = r.json()["id"]
    r = auth.delete(f"{API_URL}/intersections/{iid}")
    assert r.status_code == 204
    r = auth.get(f"{API_URL}/intersections/{iid}")
    assert r.status_code == 404


def test_add_street(auth, intersection):
    r = auth.post(f"{API_URL}/streets/",
                  json={"intersection_id": intersection["id"], "name": "_test_street"})
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "_test_street"
    assert data["intersection_id"] == intersection["id"]
    auth.delete(f"{API_URL}/streets/{data['id']}")


def test_import_csv(auth):
    csv_content = (
        "intersection_name,latitude,longitude,camera_name,rtsp_url\n"
        "_import_test_inter,7.44,125.80,_import_cam_1,rtsp://192.168.1.99:554/s1\n"
        "_import_test_inter,7.44,125.80,_import_cam_2,rtsp://192.168.1.99:554/s2\n"
    )
    r = auth.post(f"{API_URL}/intersections/import",
                  files={"file": ("test.csv", csv_content.encode(), "text/csv")})
    assert r.status_code == 200
    data = r.json()
    assert "_import_test_inter" in data["created_intersections"]
    assert len(data["created_cameras"]) == 2

    # cleanup
    ints = auth.get(f"{API_URL}/intersections/").json()
    for i in ints:
        if i["name"] == "_import_test_inter":
            auth.delete(f"{API_URL}/intersections/{i['id']}")
            break


def test_import_csv_deduplicates_intersection(auth):
    """Uploading the same intersection name twice should not create a duplicate."""
    csv_content = (
        "intersection_name,latitude,longitude,camera_name,rtsp_url\n"
        "_dedup_test_inter,7.44,125.80,_dedup_cam,rtsp://192.168.1.1:554/s1\n"
    )
    for _ in range(2):
        auth.post(f"{API_URL}/intersections/import",
                  files={"file": ("test.csv", csv_content.encode(), "text/csv")})

    ints = auth.get(f"{API_URL}/intersections/").json()
    count = sum(1 for i in ints if i["name"] == "_dedup_test_inter")
    assert count == 1, f"Expected 1 intersection, got {count}"

    for i in ints:
        if i["name"] == "_dedup_test_inter":
            auth.delete(f"{API_URL}/intersections/{i['id']}")
            break


def test_import_csv_missing_columns(auth):
    bad_csv = "intersection_name,latitude\nFoo,7.44\n"
    r = auth.post(f"{API_URL}/intersections/import",
                  files={"file": ("bad.csv", bad_csv.encode(), "text/csv")})
    assert r.status_code == 400


def test_signal_timing_round_trip(auth, intersection):
    iid = intersection["id"]

    # PATCH signal timing
    r = auth.patch(f"{API_URL}/intersections/{iid}/timing", json={
        "signal_status": "fixed_time",
        "existing_cycle_length": 80,
        "existing_green_splits": {"northbound": 20, "southbound": 20, "eastbound": 20, "westbound": 20},
    })
    assert r.status_code == 200
    data = r.json()
    assert data["signal_status"] == "fixed_time"
    assert data["existing_cycle_length"] == 80
    assert data["existing_green_splits"] == {"northbound": 20, "southbound": 20, "eastbound": 20, "westbound": 20}
    assert data["effective_green_splits"] == {"northbound": 20, "southbound": 20, "eastbound": 20, "westbound": 20}

    # GET and verify persisted
    r = auth.get(f"{API_URL}/intersections/{iid}")
    assert r.status_code == 200
    data = r.json()
    assert data["signal_status"] == "fixed_time"
    assert data["existing_cycle_length"] == 80


def test_signal_timing_equal_split_default(auth, intersection):
    iid = intersection["id"]

    # PATCH with cycle length but no explicit splits
    r = auth.patch(f"{API_URL}/intersections/{iid}/timing", json={
        "signal_status": "fixed_time",
        "existing_cycle_length": 80,
    })
    assert r.status_code == 200
    data = r.json()
    assert data["existing_green_splits"] is None
    # effective_green_splits should be equal-split: 80 / 4 = 20 per approach
    assert data["effective_green_splits"] == {"1": 20, "2": 20, "3": 20, "4": 20}


def test_signal_timing_invalid_status(auth, intersection):
    r = auth.patch(f"{API_URL}/intersections/{intersection['id']}/timing", json={
        "signal_status": "bad_value",
    })
    assert r.status_code == 422


def test_signal_timing_404(auth):
    r = auth.patch(f"{API_URL}/intersections/999999/timing", json={
        "signal_status": "unsignalized",
    })
    assert r.status_code == 404
