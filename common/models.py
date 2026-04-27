from sqlalchemy import Column, Integer, String, ForeignKey, DateTime, Float
from sqlalchemy.orm import relationship
from common.database import Base
from sqlalchemy.sql import func


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(255), nullable=False, unique=True)
    hash = Column(String(255), nullable=False)
    session = Column(String(255), nullable=True)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Log(Base):
    __tablename__ = "logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    message = Column(String(255), nullable=False)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Intersection(Base):
    __tablename__ = "intersections"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    streets = relationship("Street", back_populates="intersection", cascade="all, delete")
    cctvs = relationship("CCTV", back_populates="intersection", cascade="all, delete")


class Street(Base):
    __tablename__ = "streets"
    id = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    intersection = relationship("Intersection", back_populates="streets")
    regions = relationship("Region", back_populates="street", cascade="all, delete")


class CCTV(Base):
    __tablename__ = "cctvs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    intersection_id = Column(Integer, ForeignKey("intersections.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    rtsp_url = Column(String(255), nullable=False)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    worker_id = Column(String(255), nullable=True)
    claimed_at = Column(DateTime(timezone=True), nullable=True)
    intersection = relationship("Intersection", back_populates="cctvs")
    detections = relationship("Detection", back_populates="cctv", cascade="all, delete")
    regions = relationship("Region", back_populates="cctv", cascade="all, delete")


class Detection(Base):
    __tablename__ = "detections"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cctv_id = Column(Integer, ForeignKey("cctvs.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(255), nullable=False)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    cctv = relationship("CCTV", back_populates="detections")
    detections_in_regions = relationship("DetectionInRegion", back_populates="detection", cascade="all, delete")


class Region(Base):
    __tablename__ = "regions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cctv_id = Column(Integer, ForeignKey("cctvs.id", ondelete="CASCADE"), nullable=False)
    street_id = Column(Integer, ForeignKey("streets.id", ondelete="CASCADE"), nullable=False)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    cctv = relationship("CCTV", back_populates="regions")
    street = relationship("Street", back_populates="regions")
    region_points = relationship("RegionPoint", back_populates="region", cascade="all, delete")
    detections_in_regions = relationship("DetectionInRegion", back_populates="region", cascade="all, delete")


class RegionPoint(Base):
    __tablename__ = "region_points"
    id = Column(Integer, primary_key=True, autoincrement=True)
    region_id = Column(Integer, ForeignKey("regions.id", ondelete="CASCADE"), nullable=False)
    x = Column(Integer, nullable=False)
    y = Column(Integer, nullable=False)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    region = relationship("Region", back_populates="region_points")


class DetectionInRegion(Base):
    __tablename__ = "detections_in_regions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    region_id = Column(Integer, ForeignKey("regions.id", ondelete="CASCADE"), nullable=False)
    detection_id = Column(Integer, ForeignKey("detections.id", ondelete="CASCADE"), nullable=False)
    time = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    region = relationship("Region", back_populates="detections_in_regions")
    detection = relationship("Detection", back_populates="detections_in_regions")