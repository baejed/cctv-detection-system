from server.schemas import IntersectionCreate, IntersectionUpdate, IntersectionResponse
from server.utils import log_and_commit, get_current_user
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from common.models import User, Intersection, CCTV
from common.database import get_db
from sqlalchemy.orm import Session
from typing import Annotated
import csv
import io


router = APIRouter(
    prefix="/intersections",
    tags=["Intersections"]
)


@router.post("/", response_model=IntersectionResponse)
def create_intersection(
    intersection: IntersectionCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    db_intersection = Intersection(name=intersection.name, latitude=intersection.latitude, longitude=intersection.longitude)
    db.add(db_intersection)
    log_and_commit(f"User {user.username} created intersection {db_intersection.name}", db)
    db.refresh(db_intersection)
    return db_intersection


@router.get("/", response_model=list[IntersectionResponse])
def get_intersections(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> list[IntersectionResponse]:
    return db.query(Intersection).all()


@router.get("/{intersection_id}", response_model=IntersectionResponse)
def get_intersection(
    intersection_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
) -> IntersectionResponse:
    intersection = db.get(Intersection, intersection_id)

    if not intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")
    
    return intersection


@router.put("/{intersection_id}", response_model=IntersectionResponse)
def update_intersection(
    intersection_id: int,
    intersection: IntersectionUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IntersectionResponse:
    db_intersection = db.get(Intersection, intersection_id)

    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")
    
    message = f"User {user.username} updated intersection {db_intersection.name}"

    if intersection.name:
        old_name = db_intersection.name
        db_intersection.name = intersection.name
        message = f"User {user.username} updated intersection {old_name} to {db_intersection.name}"
    
    if intersection.latitude:
        db_intersection.latitude = intersection.latitude

    if intersection.longitude:
        db_intersection.longitude = intersection.longitude

    log_and_commit(message, db)
    db.refresh(db_intersection)
    return db_intersection


@router.post("/import")
async def import_csv(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Bulk-import intersections and cameras from a CSV file.

    Required columns: intersection_name, latitude, longitude, camera_name, rtsp_url
    Intersections are matched by name — existing ones are reused, not duplicated.
    """
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")  # strip BOM if present
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded")

    reader = csv.DictReader(io.StringIO(text))
    required = {"intersection_name", "latitude", "longitude", "camera_name", "rtsp_url"}
    if not reader.fieldnames or not required.issubset(set(f.strip() for f in reader.fieldnames)):
        missing = required - set(f.strip() for f in (reader.fieldnames or []))
        raise HTTPException(status_code=400, detail=f"Missing columns: {', '.join(sorted(missing))}")

    inter_cache: dict[str, Intersection] = {}
    created_intersections: list[str] = []
    created_cameras: list[str] = []
    errors: list[str] = []

    rows = list(reader)
    for i, row in enumerate(rows, start=2):  # row 1 is header
        row = {k.strip(): v.strip() for k, v in row.items()}
        name = row.get("intersection_name", "")
        cam_name = row.get("camera_name", "")
        rtsp_url = row.get("rtsp_url", "")

        if not name or not cam_name or not rtsp_url:
            errors.append(f"Row {i}: missing required field")
            continue

        try:
            lat = float(row.get("latitude") or 0)
            lng = float(row.get("longitude") or 0)
        except ValueError:
            errors.append(f"Row {i}: invalid latitude/longitude")
            continue

        # reuse or create intersection
        if name not in inter_cache:
            existing = db.query(Intersection).filter(Intersection.name == name).first()
            if existing:
                inter_cache[name] = existing
            else:
                inter = Intersection(name=name, latitude=lat, longitude=lng)
                db.add(inter)
                db.flush()
                inter_cache[name] = inter
                created_intersections.append(name)

        intersection = inter_cache[name]

        # skip duplicate cameras (same name + intersection)
        dup = db.query(CCTV).filter(
            CCTV.intersection_id == intersection.id,
            CCTV.name == cam_name,
        ).first()
        if dup:
            errors.append(f"Row {i}: camera '{cam_name}' already exists at '{name}' (skipped)")
            continue

        cam = CCTV(name=cam_name, intersection_id=intersection.id, rtsp_url=rtsp_url)
        db.add(cam)
        created_cameras.append(cam_name)

    log_and_commit(
        f"User {user.username} bulk-imported {len(created_intersections)} intersections "
        f"and {len(created_cameras)} cameras via CSV",
        db,
    )

    return {
        "created_intersections": created_intersections,
        "created_cameras": created_cameras,
        "errors": errors,
    }


@router.delete("/{intersection_id}")
def delete_intersection(
    intersection_id: int,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    db_intersection = db.get(Intersection, intersection_id)

    if not db_intersection:
        raise HTTPException(status_code=404, detail="Intersection not found")

    db.delete(db_intersection)
    log_and_commit(f"User {user.username} deleted intersection {db_intersection.name}", db)
    return {"detail": "Intersection deleted"}