from pydantic import BaseModel, ConfigDict
from datetime import datetime
from typing import Optional


class UserBase(BaseModel):
    username: str
    password: str


class UserCreate(UserBase):
    pass


class UserUpdate(BaseModel):
    password: Optional[str] = None


class UserResponse(BaseModel):
    id: int
    username: str
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class IntersectionBase(BaseModel):
    name: str
    latitude: float
    longitude: float


class IntersectionCreate(IntersectionBase):
    pass


class IntersectionUpdate(BaseModel):
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class IntersectionResponse(IntersectionBase):
    id: int
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class StreetBase(BaseModel):
    intersection_id: int
    name: str


class StreetCreate(StreetBase):
    pass


class StreetUpdate(BaseModel):
    name: Optional[str] = None


class StreetResponse(StreetBase):
    id: int
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class CCTVBase(BaseModel):
    intersection_id: int
    name: str
    rtsp_url: str


class CCTVCreate(CCTVBase):
    pass


class CCTVUpdate(BaseModel):
    name: Optional[str] = None
    rtsp_url: Optional[str] = None
    intersection_id: Optional[int] = None


class CCTVResponse(CCTVBase):
    id: int
    status: str
    last_error: str | None = None
    is_being_viewed: bool
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class DetectionBase(BaseModel):
    cctv_id: int
    type: str


class DetectionResponse(DetectionBase):
    id: int
    time: datetime
    model_config = ConfigDict(from_attributes=True)


class RegionPointBase(BaseModel):
    x: float
    y: float


class RegionBase(BaseModel):
    cctv_id: int
    street_id: int
    direction: str = 'unknown'
    region_points: list[RegionPointBase]


class RegionCreate(RegionBase):
    pass


class RegionUpdate(BaseModel):
    cctv_id: Optional[int] = None
    street_id: Optional[int] = None
    direction: Optional[str] = None
    region_points: Optional[list[RegionPointBase]] = None


class RegionResponse(RegionBase):
    id: int
    time: datetime
    model_config = ConfigDict(from_attributes=True)
